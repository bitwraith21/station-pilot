use crate::ASSETS;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read},
    net::{Ipv4Addr, TcpListener},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewWindow, WindowEvent,
};
use tiny_http::{Header, Method, Request, Response, ResponseBox, Server};
use uuid::Uuid;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CloseAction {
    #[default]
    Ask,
    Tray,
    Quit,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Preferences {
    enabled: bool,
    port: u16,
    shared: bool,
    close_action: CloseAction,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Command {
    Status,
    Check { port: u16 },
    Apply { preferences: Value, snapshot: Value },
    Publish { snapshot: Value },
    Close { keep: bool },
}

struct Snapshot {
    revision: String,
    profile: Value,
    keys: HashSet<String>,
}

#[derive(Deserialize)]
struct LinkRequest {
    key: String,
    #[serde(default)]
    parts: Vec<String>,
}

#[derive(Serialize)]
struct Link {
    key: String,
    parts: Vec<String>,
    kind: &'static str,
    name: String,
    size: u64,
    modified: u64,
}

struct Remote {
    window: WebviewWindow,
    directory: PathBuf,
    shared: AtomicBool,
    picking: AtomicBool,
    snapshot: Mutex<Option<Snapshot>>,
}

struct Listener {
    stopped: Arc<AtomicBool>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
struct Session {
    listener: Option<Listener>,
    preferences: Preferences,
    error: Option<String>,
}

#[derive(Clone)]
pub struct Dock {
    remote: Arc<Remote>,
    session: Arc<Mutex<Session>>,
    tray: bool,
}

impl Dock {
    pub fn attach(window: &WebviewWindow, directory: PathBuf) -> tauri::Result<Self> {
        let tray = setup_tray(window).is_ok();
        let mut preferences: Preferences = fs::read(directory.join("DockSettings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        if !valid_key(&preferences.token) {
            preferences.token = Uuid::new_v4().simple().to_string();
        }
        let dock = Self {
            remote: Arc::new(Remote {
                window: window.clone(),
                directory,
                shared: AtomicBool::new(preferences.shared),
                picking: AtomicBool::new(false),
                snapshot: Mutex::new(None),
            }),
            session: Arc::new(Mutex::new(Session {
                preferences: preferences.clone(),
                ..Session::default()
            })),
            tray,
        };
        if preferences.enabled {
            if let Err(error) = dock.apply(preferences) {
                dock.session.lock().unwrap().error = Some(error);
            }
        }
        let handling = dock.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_action = handling.session.lock().unwrap().preferences.close_action;
                match close_action {
                    CloseAction::Tray if handling.tray => {
                        api.prevent_close();
                        let _ = handling.remote.window.hide();
                    }
                    CloseAction::Ask if handling.tray => {
                        api.prevent_close();
                        let _ = handling.remote.window.eval(
                            "(() => { const prompt = document.getElementById('close-desktop-dialog'); if (prompt && !prompt.open) prompt.showModal(); })()"
                        );
                    }
                    _ => handling.remote.window.app_handle().exit(0),
                }
            }
        });
        Ok(dock)
    }

    pub fn execute(&self, command: Command) -> Result<Value, String> {
        match command {
            Command::Status => Ok(self.status()),
            Command::Check { port } => {
                let session = self.session.lock().unwrap();
                if port == 0 || session.listener.is_some() && port == session.preferences.port {
                    return Ok(json!({ "available": true }));
                }
                bind(port).map_err(port_error)?;
                Ok(json!({ "available": true }))
            }
            Command::Apply {
                preferences,
                snapshot,
            } => {
                let mut proposed: Preferences =
                    serde_json::from_value(preferences).map_err(|e| e.to_string())?;
                proposed.token = self.session.lock().unwrap().preferences.token.clone();
                if !self.tray && matches!(proposed.close_action, CloseAction::Tray) {
                    return Err("A system tray is unavailable on this desktop.".into());
                }
                self.apply(proposed)?;
                self.remote.publish(snapshot);
                Ok(self.status())
            }
            Command::Publish { snapshot } => {
                self.remote.publish(snapshot);
                Ok(Value::Null)
            }
            Command::Close { keep } => {
                if keep {
                    if !self.tray {
                        return Err("A system tray is unavailable on this desktop.".into());
                    }
                    self.remote.window.hide().map_err(|e| e.to_string())?;
                } else {
                    self.remote.window.app_handle().exit(0);
                }
                Ok(Value::Null)
            }
        }
    }

    fn status(&self) -> Value {
        let session = self.session.lock().unwrap();
        let preferences = &session.preferences;
        let url = session.listener.as_ref().map(|_| {
            format!(
                "http://127.0.0.1:{}/dock/{}/",
                preferences.port, preferences.token
            )
        });
        json!({
            "enabled": session.listener.is_some(), "port": preferences.port,
            "shared": preferences.shared, "closeAction": preferences.close_action,
            "trayAvailable": self.tray, "url": url, "error": session.error
        })
    }

    fn apply(&self, mut preferences: Preferences) -> Result<(), String> {
        let mut session = self.session.lock().unwrap();
        let replace = preferences.enabled
            && (session.listener.is_none()
                || preferences.port != session.preferences.port && preferences.port != 0);
        let pending = if replace {
            let listener = bind(preferences.port).map_err(port_error)?;
            preferences.port = listener.local_addr().map_err(port_error)?.port();
            let server = Server::from_listener(listener, None).map_err(|e| e.to_string())?;
            Some(server)
        } else {
            if preferences.enabled && preferences.port == 0 {
                preferences.port = session.preferences.port;
            }
            None
        };
        let directory = &self.remote.directory;
        fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        let temporary = directory.join("DockSettings.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&preferences).map_err(|e| e.to_string())?,
        )
        .and_then(|_| fs::rename(&temporary, directory.join("DockSettings.json")))
        .map_err(|e| format!("Could not save dock settings. {e}"))?;
        self.remote
            .shared
            .store(preferences.shared, Ordering::Relaxed);
        if let Some(server) = pending {
            session.listener = Some(launch(server, self.remote.clone(), &preferences));
        } else if !preferences.enabled {
            session.listener = None;
        }
        session.preferences = preferences;
        session.error = None;
        Ok(())
    }
}

#[cfg(unix)]
#[tauri::command]
pub fn dock_command(dock: tauri::State<'_, Dock>, request: Command) -> Result<Value, String> {
    dock.execute(request)
}

fn setup_tray(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    let open = MenuItem::with_id(
        app,
        "open-station-pilot",
        "Show Station Pilot",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "quit-station-pilot",
        "Quit Station Pilot",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("station-pilot")
        .tooltip("Station Pilot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-station-pilot" => show(app),
            "quit-station-pilot" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn bind(port: u16) -> io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port))
}

fn port_error(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::AddrInUse {
        "That port is already in use. Choose another port or use Auto.".into()
    } else {
        format!("Could not open the requested port. {error}")
    }
}

fn launch(server: Server, remote: Arc<Remote>, preferences: &Preferences) -> Listener {
    let server = Arc::new(server);
    let stopped = Arc::new(AtomicBool::new(false));
    let prefix = format!("/dock/{}/", preferences.token);
    let host = format!("127.0.0.1:{}", preferences.port);
    for _ in 0..4 {
        let (server, stopped, remote) = (server.clone(), stopped.clone(), remote.clone());
        let (prefix, host) = (prefix.clone(), host.clone());
        thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                match server.recv_timeout(Duration::from_millis(200)) {
                    Ok(Some(mut request)) => {
                        let response = if stopped.load(Ordering::Relaxed) {
                            failure(503, "The OBS dock has been stopped.")
                        } else {
                            respond(&remote, &host, &prefix, &mut request)
                        };
                        let _ = request.respond(response);
                    }
                    Ok(None) => {}
                    Err(_) => break,
                }
            }
        });
    }
    Listener { stopped }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid response header")
}

fn protect(response: ResponseBox, content_type: &str) -> ResponseBox {
    response
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("X-Frame-Options", "DENY"))
}

fn json_response(value: Value) -> ResponseBox {
    protect(
        Response::from_string(value.to_string()).boxed(),
        "application/json",
    )
}

fn failure(code: u16, message: &str) -> ResponseBox {
    json_response(json!({ "error": message })).with_status_code(code)
}

fn request_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn parse_body<T: serde::de::DeserializeOwned>(request: &mut Request) -> Option<T> {
    let mut bytes = Vec::new();
    request
        .as_reader()
        .take(32_769)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 32_768 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn respond(remote: &Arc<Remote>, host: &str, prefix: &str, request: &mut Request) -> ResponseBox {
    if request_header(request, "Host") != Some(host) {
        return failure(404, "Dock URL not found.");
    }
    let address = request.url().to_owned();
    let (path, query) = address.split_once('?').unwrap_or((&address, ""));
    let Some(path) = path.strip_prefix(prefix) else {
        return failure(404, "Dock URL not found.");
    };
    if !path.starts_with("api/") {
        if request.method() != &Method::Get {
            return failure(405, "Use GET.");
        }
        let name = if path.is_empty() { "index.html" } else { path };
        return match ASSETS.iter().find(|(asset, _, _)| *asset == name) {
            Some((_, kind, bytes)) => protect(Response::from_data(*bytes).boxed(), kind),
            None => failure(404, "Page not found."),
        };
    }
    let origin = format!("http://{host}");
    if request_header(request, "X-Station-Pilot") != Some("dock")
        || request_header(request, "Origin").is_some_and(|value| value != origin)
    {
        return failure(403, "This dock request was blocked.");
    }

    if path == "api/profile" && request.method() == &Method::Get {
        return json_response(remote.profile(query.strip_prefix("since=").unwrap_or("")));
    }
    if request.method() != &Method::Post {
        return failure(405, "Use POST.");
    }

    if path == "api/pick" {
        if remote.shared.load(Ordering::Relaxed) {
            return failure(403, "Link music in the desktop app.");
        }
        #[derive(Deserialize)]
        struct Pick {
            folder: bool,
        }
        let Some(pick) = parse_body::<Pick>(request) else {
            return failure(400, "Invalid picker request.");
        };
        return match remote.pick(pick.folder) {
            Ok(links) => json_response(json!(links)),
            Err(error) => failure(409, &error),
        };
    }

    if !matches!(path, "api/children" | "api/stat" | "api/audio") {
        return failure(404, "Unknown dock request.");
    }
    let Some(link) = parse_body::<LinkRequest>(request) else {
        return failure(400, "Invalid music link.");
    };
    let Ok(file) = remote.resolve(&link) else {
        return failure(404, "The original music location is unavailable.");
    };
    match path {
        "api/children" => {
            let Ok(entries) = fs::read_dir(file) else {
                return failure(404, "The folder could not be opened.");
            };
            let links: Vec<_> = entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let mut parts = link.parts.clone();
                    parts.push(entry.file_name().into_string().ok()?);
                    describe(&link.key, parts, &entry.path()).ok()
                })
                .collect();
            json_response(json!(links))
        }
        "api/stat" => match describe(&link.key, link.parts, &file) {
            Ok(info) => json_response(json!(info)),
            Err(_) => failure(404, "The music location is unavailable."),
        },
        _ => {
            let ext = file
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !file.is_file()
                || !matches!(
                    ext.as_str(),
                    "mp3"
                        | "wav"
                        | "flac"
                        | "ogg"
                        | "oga"
                        | "opus"
                        | "m4a"
                        | "aac"
                        | "aif"
                        | "aiff"
                        | "wma"
                )
            {
                return failure(404, "This link does not point to a supported audio file.");
            }
            match File::open(file) {
                Ok(data) => protect(
                    Response::from_file(data).boxed(),
                    "application/octet-stream",
                ),
                Err(_) => failure(404, "The original audio is unavailable."),
            }
        }
    }
}

fn valid_key(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn describe(key: &str, parts: Vec<String>, path: &Path) -> io::Result<Link> {
    let info = path.symlink_metadata()?;
    if !info.is_file() && !info.is_dir() {
        return Err(io::Error::other("Unsupported source."));
    }
    Ok(Link {
        key: key.into(),
        parts,
        kind: if info.is_dir() { "directory" } else { "file" },
        name: path
            .file_name()
            .unwrap_or(path.as_os_str())
            .to_string_lossy()
            .into_owned(),
        size: info.len(),
        modified: info
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

impl Remote {
    fn publish(&self, profile: Value) {
        if profile.is_null() {
            return;
        }
        let library = &profile["library"];
        let mut snapshot = self.snapshot.lock().unwrap();
        if snapshot
            .as_ref()
            .is_some_and(|current| current.profile == profile)
        {
            return;
        }
        let keys = library["folders"]
            .as_array()
            .into_iter()
            .flatten()
            .chain(
                library["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|track| &track["source"]),
            )
            .filter_map(|source| {
                #[cfg(windows)]
                let key = source["nativeKey"].as_str();
                #[cfg(unix)]
                let key = source["nativeLink"]["key"].as_str();
                key.filter(|key| valid_key(key)).map(String::from)
            })
            .collect();
        *snapshot = Some(Snapshot {
            revision: Uuid::new_v4().simple().to_string(),
            profile,
            keys,
        });
    }

    fn profile(&self, known_revision: &str) -> Value {
        if !self.shared.load(Ordering::Relaxed) {
            return json!({ "shared": false, "revision": "" });
        }
        let snapshot = self.snapshot.lock().unwrap();
        match snapshot.as_ref() {
            Some(snapshot) if snapshot.revision != known_revision => {
                json!({ "shared": true, "revision": snapshot.revision, "snapshot": snapshot.profile })
            }
            Some(snapshot) => json!({ "shared": true, "revision": snapshot.revision }),
            None => json!({ "shared": true, "revision": "" }),
        }
    }

    fn resolve(&self, link: &LinkRequest) -> io::Result<PathBuf> {
        if !valid_key(&link.key) || link.parts.len() > 128 {
            return Err(io::Error::other("Invalid music link."));
        }
        let root = if self.shared.load(Ordering::Relaxed) {
            if !self
                .snapshot
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|snapshot| snapshot.keys.contains(&link.key))
            {
                return Err(io::Error::other("Music link is unavailable."));
            }
            desktop_path(&self.directory.join("MusicLinks").join(&link.key))?
        } else {
            bookmark_path(&fs::read(
                self.directory.join("ObsMusicLinks").join(&link.key),
            )?)?
        }
        .canonicalize()?;
        let mut file = root.clone();
        for part in &link.parts {
            let mut components = Path::new(part).components();
            if !matches!(components.next(), Some(Component::Normal(name)) if name == std::ffi::OsStr::new(part))
                || components.next().is_some()
            {
                return Err(io::Error::other("Invalid path component."));
            }
            file.push(part);
        }
        let file = file.canonicalize()?;
        if !file.starts_with(&root) {
            return Err(io::Error::other("Outside the linked music source."));
        }
        Ok(file)
    }

    fn pick(self: &Arc<Self>, folder: bool) -> Result<Vec<Link>, String> {
        if self.picking.swap(true, Ordering::AcqRel) {
            return Err("A music picker is already open.".into());
        }
        let (sender, receiver) = mpsc::channel();
        let remote = self.clone();
        if let Err(error) = self.window.run_on_main_thread(move || {
            show(remote.window.app_handle());
            let result = pick_paths(&remote.window, folder).and_then(|paths| {
                if remote.shared.load(Ordering::Relaxed) {
                    return Err("The OBS dock changed profiles.".into());
                }
                paths
                    .into_iter()
                    .map(|path| remote.grant(&path).map_err(|e| e.to_string()))
                    .collect()
            });
            remote.picking.store(false, Ordering::Release);
            let _ = sender.send(result);
        }) {
            self.picking.store(false, Ordering::Release);
            return Err(error.to_string());
        }
        receiver
            .recv_timeout(Duration::from_secs(300))
            .map_err(|_| "Music picker did not finish.".to_owned())?
    }

    fn grant(&self, path: &Path) -> io::Result<Link> {
        let path = path.canonicalize()?;
        let directory = self.directory.join("ObsMusicLinks");
        fs::create_dir_all(&directory)?;
        for entry in fs::read_dir(&directory)?.filter_map(Result::ok) {
            let key = entry.file_name().to_string_lossy().into_owned();
            if valid_key(&key)
                && fs::read(entry.path())
                    .ok()
                    .and_then(|bytes| bookmark_path(&bytes).ok())
                    .as_ref()
                    == Some(&path)
            {
                return describe(&key, vec![], &path);
            }
        }
        let key = Uuid::new_v4().simple().to_string();
        let result = describe(&key, vec![], &path)?;
        fs::write(directory.join(&key), path_bytes(&path))?;
        Ok(result)
    }
}

#[cfg(windows)]
fn desktop_path(bookmark: &Path) -> io::Result<PathBuf> {
    let bytes = fs::read(bookmark)?;
    bookmark_path(
        bytes
            .get(1..)
            .ok_or_else(|| io::Error::other("Missing music bookmark."))?,
    )
}

#[cfg(unix)]
fn desktop_path(bookmark: &Path) -> io::Result<PathBuf> {
    bookmark_path(&fs::read(bookmark)?)
}

#[cfg(windows)]
fn bookmark_path(bytes: &[u8]) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    if bytes.is_empty() || !bytes.len().is_multiple_of(2) {
        return Err(io::Error::other("Invalid music bookmark."));
    }
    let path: Vec<_> = bytes
        .chunks_exact(2)
        .map(|word| u16::from_le_bytes([word[0], word[1]]))
        .collect();
    Ok(std::ffi::OsString::from_wide(&path).into())
}

#[cfg(unix)]
fn bookmark_path(bytes: &[u8]) -> io::Result<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    if bytes.is_empty() {
        return Err(io::Error::other("Invalid music bookmark."));
    }
    Ok(std::ffi::OsStr::from_bytes(bytes).into())
}

#[cfg(windows)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(unix)]
fn path_bytes(path: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().to_vec()
}

#[cfg(windows)]
fn pick_paths(window: &WebviewWindow, folder: bool) -> Result<Vec<PathBuf>, String> {
    let owner = window.hwnd().map_err(|e| e.to_string())?;
    crate::windows_host::pick_media(owner, folder)
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| path.to_os_string().into())
                .collect()
        })
        .map_err(|e| e.to_string())
}

#[cfg(unix)]
fn pick_paths(window: &WebviewWindow, folder: bool) -> Result<Vec<PathBuf>, String> {
    let dialog = rfd::FileDialog::new().set_parent(window);
    Ok(if folder {
        dialog.pick_folder().into_iter().collect()
    } else {
        dialog
            .add_filter(
                "Audio",
                &[
                    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma",
                ],
            )
            .pick_files()
            .unwrap_or_default()
    })
}
