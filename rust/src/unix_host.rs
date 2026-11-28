use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    os::unix::ffi::{OsStrExt, OsStringExt},
    sync::Mutex,
};
use std::{
    env, fs, io,
    path::{Component, Path, PathBuf},
    process::Command,
    time::UNIX_EPOCH,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{DragDropEvent, WindowEvent};

struct Library {
    directory: PathBuf,
    keys: Mutex<HashMap<PathBuf, String>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Link {
    key: String,
    parts: Vec<String>,
    name: String,
    kind: String,
    size: u64,
    modified: u64,
}

fn describe(key: &str, parts: Vec<String>, path: &Path) -> io::Result<Link> {
    let info = path.symlink_metadata()?;
    if !info.is_file() && !info.is_dir() {
        return Err(io::Error::other("Unsupported file type"));
    }
    Ok(Link {
        key: key.into(),
        parts,
        name: path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| io::Error::other("Unsupported filename"))?
            .into(),
        kind: if info.is_dir() { "directory" } else { "file" }.into(),
        size: info.len(),
        modified: info
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
}

impl Library {
    fn open(directory: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&directory)?;
        let mut keys = HashMap::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let key = entry.file_name().to_string_lossy().into_owned();
            if key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
                let bytes = fs::read(entry.path())?;
                keys.insert(PathBuf::from(std::ffi::OsString::from_vec(bytes)), key);
            }
        }
        Ok(Self {
            directory,
            keys: Mutex::new(keys),
        })
    }

    fn grant(&self, source: PathBuf) -> io::Result<Link> {
        let path = source.canonicalize()?;
        let mut keys = self
            .keys
            .lock()
            .map_err(|_| io::Error::other("Library lock unavailable"))?;
        if let Some(key) = keys.get(&path) {
            return describe(key, Vec::new(), &path);
        }
        let key = uuid::Uuid::new_v4().simple().to_string();
        let link = describe(&key, Vec::new(), &path)?;
        fs::write(self.directory.join(&key), path.as_os_str().as_bytes())?;
        keys.insert(path, key);
        Ok(link)
    }

    fn resolve(&self, key: &str, parts: &[String]) -> io::Result<PathBuf> {
        if key.len() != 32 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(io::Error::other("Invalid library link"));
        }
        let root = PathBuf::from(std::ffi::OsString::from_vec(fs::read(
            self.directory.join(key),
        )?));
        let mut path = root.clone();
        for part in parts {
            if !matches!(
                Path::new(part).components().collect::<Vec<_>>().as_slice(),
                [Component::Normal(_)]
            ) || part.contains('/')
            {
                return Err(io::Error::other("Invalid library path"));
            }
            path.push(part);
        }
        let path = path.canonicalize()?;
        if !path.starts_with(&root) {
            return Err(io::Error::other("Outside linked source"));
        }
        Ok(path)
    }
}

#[tauri::command]
async fn pick_sources(library: State<'_, Library>, folder: bool) -> Result<Vec<Link>, String> {
    let picker = rfd::AsyncFileDialog::new();
    let paths = if folder {
        picker.pick_folder().await.into_iter().collect()
    } else {
        picker
            .add_filter(
                "Audio",
                &[
                    "mp3", "flac", "wav", "ogg", "opus", "m4a", "aac", "aiff", "aif", "wma", "oga",
                ],
            )
            .pick_files()
            .await
            .unwrap_or_default()
    };
    paths
        .into_iter()
        .map(|p| library.grant(p.path().into()).map_err(|e| e.to_string()))
        .collect()
}

#[tauri::command]
async fn list_children(
    library: State<'_, Library>,
    key: String,
    parts: Vec<String>,
) -> Result<Vec<Link>, String> {
    let dir = library.resolve(&key, &parts).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = item.map_err(|e| e.to_string())?;
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        let mut nested = parts.clone();
        nested.push(name);
        if let Ok(link) = describe(&key, nested, &entry.path()) {
            result.push(link);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn inspect_link(library: State<'_, Library>, key: String, parts: Vec<String>) -> Result<Link, String> {
    let path = library.resolve(&key, &parts).map_err(|e| e.to_string())?;
    describe(&key, parts, &path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_music(
    library: State<'_, Library>,
    key: String,
    parts: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let path = library.resolve(&key, &parts).map_err(|e| e.to_string())?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "mp3" | "flac" | "wav" | "ogg" | "opus" | "m4a" | "aac" | "aiff" | "aif" | "wma" | "oga"
    ) {
        return Err("Unsupported audio file".into());
    }
    fs::read(path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_export(filename: String, contents: String, reveal: Option<bool>) -> Result<bool, String> {
    if Path::new(&filename).file_name().and_then(|s| s.to_str()) != Some(filename.as_str())
        || !(filename.ends_with(".json") || filename.ends_with(".csv"))
    {
        return Err("Invalid export filename".into());
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name(&filename)
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(contents.as_bytes()).await.map_err(|e| e.to_string())?;
    if reveal == Some(true) {
        let folder = file.path().parent().ok_or("Backup saved. Its folder could not be determined.")?;
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        Command::new(opener).arg(folder).spawn()
            .map_err(|error| format!("Backup saved. Could not open its folder. {error}"))?;
    }
    Ok(true)
}

#[tauri::command]
fn donate() -> Result<(), String> {
    open_browser("https://ko-fi.com/bitwraith21")
}

#[tauri::command]
fn open_releases() -> Result<(), String> {
    open_browser(crate::RELEASES_URL)
}

fn open_browser(url: &str) -> Result<(), String> {
    Command::new(if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    })
    .arg(url)
    .spawn()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn connect_linux_drop(target: tauri::WebviewWindow) -> tauri::Result<()> {
    use gtk::{gdk, gio, prelude::*};
    use std::{cell::{Cell, RefCell}, rc::Rc};

    let window = target.clone();
    target.with_webview(move |platform| {
        let view = platform.inner();
        let uri_list = gdk::Atom::intern("text/uri-list");
        let external_files = move |context: &gdk::DragContext| {
            context.drag_get_source_widget().is_none() && context.list_targets().contains(&uri_list)
        };
        let pending = Rc::new(RefCell::new(None::<(gdk::DragContext, i32, i32)>));

        let highlight = window.clone();
        let last_motion = Cell::new(None::<u32>);
        view.connect_drag_motion(move |_, context, x, y, time| {
            if !external_files(context) { return false; }
            // GDK positions are widget coordinates and already account for display scaling.
            context.drag_status(gdk::DragAction::COPY, time);
            if last_motion.get().is_none_or(|last| time.wrapping_sub(last) >= 32) {
                let _ = highlight.eval(format!(
                    "window.dispatchEvent(new CustomEvent('station-native-drag',{{detail:{{x:{x},y:{y}}}}}))"
                ));
                last_motion.set(Some(time));
            }
            true
        });

        let clear = window.clone();
        view.connect_drag_leave(move |_, context, _| {
            if external_files(context) {
                let _ = clear.eval("window.dispatchEvent(new CustomEvent('station-native-drag'))");
            }
        });

        let requested = pending.clone();
        view.connect_drag_drop(move |view, context, x, y, time| {
            if !external_files(context) { return false; }
            requested.replace(Some((context.clone(), x, y)));
            view.drag_get_data(context, &uri_list, time);
            true
        });

        view.connect_drag_data_received(move |view, context, _, _, data, _, time| {
            if data.target() != uri_list ||
                !pending.borrow().as_ref().is_some_and(|(requested, _, _)| requested == context) {
                return;
            }
            let (_, x, y) = pending.take().unwrap();
            let paths: Vec<_> = data.uris().iter().filter_map(|uri| gio::File::for_uri(uri).path()).collect();
            view.stop_signal_emission_by_name("drag-data-received");
            context.drag_finish(!paths.is_empty(), false, time);
            send_native_drop(&window, &paths, x.into(), y.into());
        });
    })
}

fn send_native_drop(target: &tauri::WebviewWindow, paths: &[PathBuf], x: f64, y: f64) {
    let library = target.state::<Library>();
    let links: Vec<_> = paths.iter().filter_map(|path| library.grant(path.clone()).ok()).collect();
    let payload = serde_json::json!({"links": links, "x": x, "y": y});
    let _ = target.eval(format!(
        "window.dispatchEvent(new CustomEvent('station-native-drop',{{detail:{payload}}}))"
    ));
}

pub fn main() {
    let home = PathBuf::from(env::var_os("HOME").expect("Home directory is unavailable"));
    let data = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Station Pilot/data")
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or(home.join(".local/share"))
            .join("station-pilot/data")
    };
    fs::create_dir_all(&data).expect("Could not open Station Pilot data");
    let lock = fs::File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join(".workstation.lock"))
        .expect("Could not open workstation lock");
    let reopen = data.join(".show-workstation");
    if lock.try_lock().is_err() {
        let _ = fs::write(&reopen, b"");
        return;
    }
    let _ = fs::remove_file(&reopen);
    let bookmarks = data.join("MusicLinks");
    tauri::Builder::default()
        .manage(Library::open(bookmarks).expect("Could not open music links"))
        .invoke_handler(tauri::generate_handler![pick_sources,list_children,read_music,inspect_link,save_export,donate,open_releases,crate::dock::dock_command])
        .setup(move |app| {
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Station Pilot").inner_size(1280.0,850.0).min_inner_size(560.0,480.0)
                .initialization_script(if cfg!(target_os = "linux") {
                    "window.stationPilotUnix = true; window.stationPilotLinux = true;"
                } else {
                    "window.stationPilotUnix = true;"
                })
                .on_navigation(|url| url.scheme()=="tauri" && url.host_str()==Some("localhost"));
            #[cfg(target_os="linux")]
            let builder = builder.data_directory(data.join("WebKit")).disable_drag_drop_handler();
            #[cfg(target_os="macos")]
            let builder = builder.background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
            let window = builder.build()?;
            app.manage(crate::dock::Dock::attach(&window, data.clone())?);
            let app_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if fs::remove_file(&reopen).is_ok() {
                    let handle = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || crate::dock::show(&handle));
                }
            });
            #[cfg(target_os = "linux")]
            connect_linux_drop(window.clone())?;
            #[cfg(target_os = "macos")]
            {
                let target = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position, .. }) = event {
                        let scale = target.scale_factor().unwrap_or(1.0);
                        send_native_drop(&target, paths, position.x / scale, position.y / scale);
                    }
                });
            }
            Ok(())
        }).build(tauri::generate_context!()).expect("Station Pilot could not start")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = _event {
                crate::dock::show(_app);
            }
        });
}
