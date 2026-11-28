use std::{
    env, fs, io, mem,
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    process::Command,
    
};

use tauri::{WebviewUrl, WebviewWindowBuilder};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, SetPermissionStateCompletedHandler, WebResourceRequestedEventHandler, WebMessageReceivedEventHandler};
use windows::{
    core::{w, Interface, HSTRING, PWSTR},
    Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, HWND, WAIT_ABANDONED, WAIT_OBJECT_0},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::{
            Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
            Threading::{CreateEventW, CreateMutexW, GetCurrentProcess, OpenProcessToken, ReleaseMutex, WaitForSingleObject},
        },
        UI::{
            Shell::{
                Common::COMDLG_FILTERSPEC, FileOpenDialog, FileSaveDialog, IFileOpenDialog, IFileSaveDialog, SHCreateMemStream,
                SetCurrentProcessExplicitAppUserModelID, ShellExecuteW, FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM,
                FOS_NOCHANGEDIR, FOS_OVERWRITEPROMPT, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                MessageBoxW, IDCANCEL, IDYES, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONQUESTION,
                MB_OK, MB_YESNOCANCEL,
            },
        },
    },
};


const ORIGIN: &str = "http://127.0.0.1:8765/";
#[cfg(not(feature = "offline"))]
<<<<<<< HEAD
const PRODUCT: &str = "{ADEE2188-244F-4027-A935-570093505063}";
#[cfg(feature = "offline")]
const PRODUCT: &str = "{D58C090E-DB85-4102-9989-2FD379031E3A}";
=======
const PRODUCT: &str = "{59352330-A9F0-40D0-ACDA-7E56A79DF9C2}";
#[cfg(feature = "offline")]
const PRODUCT: &str = "{450A00A2-E22F-4F08-8A65-CAF0955F1002}";
>>>>>>> d496885d508d1420684bf6196a44d75f5c08eae0

use crate::ASSETS;

type Error = Box<dyn std::error::Error>;
type Result<T> = std::result::Result<T, Error>;

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

fn current_user() -> Result<String> {
    let mut handle = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut handle)? };
    let handle = Handle(handle);
    let mut len = 0;
    let _ = unsafe { GetTokenInformation(handle.0, TokenUser, None, 0, &mut len) };
    let mut data = vec![0usize; (len as usize).div_ceil(mem::size_of::<usize>())];
    unsafe { GetTokenInformation(handle.0, TokenUser, Some(data.as_mut_ptr().cast()), len, &mut len)? };
    let token = unsafe { &*(data.as_ptr().cast::<TOKEN_USER>()) };
    let mut sid = PWSTR::null();
    unsafe { ConvertSidToStringSidW(token.User.Sid, &mut sid)? };
    let result = unsafe { sid.to_string() };
    let _ = unsafe { LocalFree(Some(HLOCAL(sid.0.cast()))) };
    Ok(result?)
}

fn paths() -> Result<(PathBuf, PathBuf)> {
    let base = env::var_os("LOCALAPPDATA").ok_or("The Windows app-data directory is unavailable.")?;
    let app = PathBuf::from(base).join("StationPilot");
    let data = app.join("Data");
    for path in [&app, &data, &data.join("WebView")] {
        if path.exists() && is_redirected(path)? {
            return Err("Station Pilot cannot open a redirected data folder.".into());
        }
    }
    let executable = env::current_exe()?;
    Ok((executable.parent().ok_or("The installation directory is unavailable.")?.to_owned(), data))
}

fn is_redirected(path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::MetadataExt;
    Ok(fs::symlink_metadata(path)?.file_attributes() & 0x400 != 0)
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    if is_redirected(source)? {
        return Err(io::Error::other("The legacy library contains a redirected file."));
    }
    if source.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            if entry.file_name() != "LOCK" {
                copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
            }
        }
    } else {
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn migrate_library(data: &Path, profile: &Path) -> Result<()> {
    const DATABASE: &str = "http_127.0.0.1_8765.indexeddb.leveldb";
    const BLOBS: &str = "http_127.0.0.1_8765.indexeddb.blob";
    let old = data.join("Browser/Default/IndexedDB");
    let parent = profile.join("EBWebView/Default");
    let target = parent.join("IndexedDB");
    if target.exists() || !old.join(DATABASE).is_dir() {
        return Ok(());
    }
    let lock_path = old.join(DATABASE).join("LOCK");
    let _lock = if lock_path.exists() {
        Some(fs::OpenOptions::new().read(true).share_mode(0).open(lock_path)
            .map_err(|error| format!("Close the previous Station Pilot window before migrating its library. {error}"))?)
    } else {
        None
    };
    fs::create_dir_all(&parent)?;
    let stage = parent.join(format!("migration-{}", std::process::id()));
    fs::create_dir(&stage)?;
    let result = (|| -> io::Result<()> {
        for name in [DATABASE, BLOBS] {
            let source = old.join(name);
            if source.exists() {
                copy_tree(&source, &stage.join(name))?;
            }
        }
        fs::rename(&stage, &target)
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    Ok(result?)
}

#[cfg(feature = "offline")]
fn configure_runtime(install: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    let runtime = install.join("Runtime");
    if !runtime.join("msedgewebview2.exe").is_file() {
        return Err("The offline runtime is missing. Repair Station Pilot using the installer.".into());
    }
    let system = PathBuf::from(env::var_os("SystemRoot").ok_or("Windows system folder unavailable")?);
    let output = Command::new(system.join("System32/icacls.exe"))
        .arg(&runtime).args(["/grant", "*S-1-15-2-1:(OI)(CI)(RX)", "*S-1-15-2-2:(OI)(CI)(RX)"])
        .creation_flags(0x08000000).output()?;
    if !output.status.success() {
        return Err("Windows could not set access to Station Pilot's embedded runtime.".into());
    }
    env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", runtime);
    Ok(())
}

#[cfg(not(feature = "offline"))]
fn configure_runtime(_: &Path) -> Result<()> {
    Ok(())
}

fn attach_assets(core: &ICoreWebView2) -> Result<()> {
    unsafe {
        let core = core.cast::<ICoreWebView2_22>()?;
        let environment = core.cast::<ICoreWebView2_2>()?.Environment()?;
        let sources = COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL;
        for pattern in [w!("http://*"), w!("https://*")] {
            core.AddWebResourceRequestedFilterWithRequestSourceKinds(
                pattern, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, sources,
            )?;
        }
        let callback = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let request = args.Request()?;
            let mut address = PWSTR::null();
            request.Uri(&mut address)?;
            let address = webview2_com::take_pwstr(address);
            if address == "https://api.github.com/repos/bitwraith21/station-pilot/releases/latest" {
                let mut method = PWSTR::null();
                request.Method(&mut method)?;
                if webview2_com::take_pwstr(method) == "GET" {
                    return Ok(());
                }
            }
            let path = address.strip_prefix(ORIGIN).unwrap_or("~");
            let path = if path.is_empty() { "index.html" } else { path };
            let response = if let Some((_, content_type, bytes)) = ASSETS.iter().find(|asset| asset.0 == path) {
                let stream = SHCreateMemStream(Some(bytes)).ok_or_else(windows::core::Error::from_thread)?;
                let headers = HSTRING::from(format!(
                    "Content-Type: {content_type}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff"
                ));
                environment.CreateWebResourceResponse(&stream, 200, w!("OK"), &headers)?
            } else {
                environment.CreateWebResourceResponse(None, 404, w!("Not Found"), w!(""))?
            };
            args.SetResponse(&response)
        }));
        let mut token = 0i64;
        core.add_WebResourceRequested(&callback, &mut token)?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct SettingsExport {
    filename: String,
    contents: String,
}

fn save_settings_export(owner: HWND, request: SettingsExport) -> Result<bool> {
    let filename = request.filename;
    if !filename.starts_with("station-pilot-settings-") || !filename.ends_with(".json")
        || Path::new(&filename).file_name().and_then(|name| name.to_str()) != Some(filename.as_str()) {
        return Err("Invalid settings backup filename.".into());
    }
    let path = unsafe {
        let picker: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
        picker.SetTitle(w!("Export Station Pilot settings"))?;
        picker.SetOptions(picker.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_OVERWRITEPROMPT)?;
        picker.SetFileTypes(&[COMDLG_FILTERSPEC { pszName: w!("JSON backup"), pszSpec: w!("*.json") }])?;
        picker.SetDefaultExtension(w!("json"))?;
        picker.SetFileName(&HSTRING::from(filename))?;
        if let Err(error) = picker.Show(Some(owner)) {
            if error.code().0 as u32 == 0x800704c7 { return Ok(false); }
            return Err(error.into());
        }
        let raw = picker.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = PathBuf::from(std::ffi::OsString::from_wide(raw.as_wide()));
        CoTaskMemFree(Some(raw.0.cast()));
        path
    };
    fs::write(&path, request.contents)?;
    let folder = path.parent().ok_or("Backup saved. Its folder could not be determined.")?;
    let status = unsafe { ShellExecuteW(Some(owner), w!("open"), &HSTRING::from(folder), None, None,
        windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL) };
    if status.0 as usize <= 32 { return Err("Backup saved. Windows could not open its folder.".into()); }
    Ok(true)
}

pub(crate) fn pick_media(owner: HWND, folders: bool) -> windows::core::Result<Vec<HSTRING>> {
    unsafe {
        let picker: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        let flags = picker.GetOptions()? | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR;
        if folders {
            picker.SetOptions(flags | FOS_PICKFOLDERS)?;
            picker.SetTitle(w!("Link a music folder to Station Pilot"))?;
        } else {
            picker.SetOptions(flags | FOS_ALLOWMULTISELECT | FOS_FILEMUSTEXIST)?;
            picker.SetTitle(w!("Link audio to Station Pilot"))?;
            picker.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("Audio files"),
                pszSpec: w!("*.mp3;*.wav;*.flac;*.ogg;*.oga;*.opus;*.m4a;*.aac;*.aif;*.aiff;*.wma"),
            }])?;
        }
        if let Err(error) = picker.Show(Some(owner)) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(Vec::new());
            }
            return Err(error);
        }
        let items = picker.GetResults()?;
        (0..items.GetCount()?).map(|index| {
            let path = items.GetItemAt(index)?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let name = HSTRING::from_wide(path.as_wide());
            CoTaskMemFree(Some(path.0.cast()));
            Ok(name)
        }).collect()
    }
}

// Only paths returned by the OS picker or a WebView2 drop can create a bookmark.
fn valid_key(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn bookmark(root: &Path, path: &HSTRING, folder: bool) -> Result<String> {
    let key = format!("{:032x}", unsafe { windows::Win32::System::Com::CoCreateGuid()? }.to_u128());
    let mut bytes = vec![u8::from(folder)];
    for unit in path.iter() { bytes.extend(unit.to_le_bytes()); }
    fs::create_dir_all(root)?;
    fs::write(root.join(&key), bytes)?;
    Ok(key)
}

fn restore(root: &Path, key: &str) -> Result<(HSTRING, bool, String)> {
    if !valid_key(key) { return Err("Invalid music bookmark.".into()); }
    let bytes = fs::read(root.join(key))?;
    if bytes.len() < 3 || bytes.len() % 2 == 0 || bytes[0] > 1 {
        return Err("Invalid music bookmark.".into());
    }
    let wide: Vec<u16> = bytes[1..].chunks_exact(2).map(|u| u16::from_le_bytes([u[0], u[1]])).collect();
    Ok((HSTRING::from_wide(&wide), bytes[0] == 1, key.to_owned()))
}

fn send_handles(core: &ICoreWebView2_23, environment: &ICoreWebView2Environment14,
                entries: &[(HSTRING, bool, String)], request: &str) -> Result<()> {
    unsafe {
        let mut source = PWSTR::null();
        core.Source(&mut source)?;
        if webview2_com::take_pwstr(source) != ORIGIN { return Ok(()); }
        let permission = COREWEBVIEW2_FILE_SYSTEM_HANDLE_PERMISSION_READ_ONLY;
        let mut handles = Vec::new();
        let mut keys = Vec::new();
        for (path, folder, key) in entries {
            let handle = if *folder {
                environment.CreateWebFileSystemDirectoryHandle(path, permission)?
            } else {
                environment.CreateWebFileSystemFileHandle(path, permission)?
            };
            handles.push(Some(handle.cast()?));
            keys.push(format!(r#""{key}""#));
        }
        let mut objects = None;
        environment.CreateObjectCollection(handles.len() as u32, handles.as_mut_ptr(), &mut objects)?;
        let payload = HSTRING::from(format!(r#"{{"type":"pilot-picker-files","request":"{request}","keys":[{}]}}"#, keys.join(",")));
        let objects = objects.ok_or("Could not prepare file handles.")?;
        core.PostWebMessageAsJsonWithAdditionalObjects(&payload, &*objects)?;
        Ok(())
    }
}

#[derive(serde::Deserialize)]
struct AudioAccessRequest {
    id: String,
    action: String,
}

fn audio_access_reply(core: &ICoreWebView2, id: &str, result: windows::core::Result<()>) {
    let reply = serde_json::json!({
        "type": "pilot-audio-access",
        "id": id,
        "error": result.err().map(|error| error.to_string()),
    });
    let _ = unsafe { core.PostWebMessageAsJson(&HSTRING::from(reply.to_string())) };
}

fn change_audio_access(core: &ICoreWebView2, request: AudioAccessRequest) {
    let permission = match request.action.as_str() {
        "allow" => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        "reset" => COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
        _ => return,
    };
    let sender = core.clone();
    let id = request.id.clone();
    let complete = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
        audio_access_reply(&sender, &id, result);
        Ok(())
    }));
    let change = || unsafe {
        let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile4>()?;
        profile.SetPermissionState(COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, &HSTRING::from(ORIGIN),
            permission, &complete)
    };
    if let Err(error) = change() { audio_access_reply(core, &request.id, Err(error)); }
}

fn picker_error(core: &ICoreWebView2, request: &str) {
    let json = HSTRING::from(format!(r#"{{"type":"pilot-picker-error","request":"{request}"}}"#));
    let _ = unsafe { core.PostWebMessageAsJson(&json) };
}

fn post_media(core: &ICoreWebView2_23, environment: &ICoreWebView2Environment14,
              owner: HWND, folders: bool, root: &Path) -> Result<()> {
    let paths = pick_media(owner, folders)?;
    if paths.is_empty() {
        unsafe { core.PostWebMessageAsJson(w!(r#"{"type":"pilot-picker-canceled"}"#))?; }
        return Ok(());
    }
    let mut entries = Vec::new();
    for path in paths {
        let key = bookmark(root, &path, folders)?;
        entries.push((path, folders, key));
    }
    send_handles(core, environment, &entries, "picker")
}

fn register_drops(core: ICoreWebView2_23, environment: ICoreWebView2Environment14, root: PathBuf) -> Result<()> {
    let sender = core.clone();
    let listener = WebMessageReceivedEventHandler::create(Box::new(move |_, args| unsafe {
        let Some(args) = args else { return Ok(()); };
        let mut uri = PWSTR::null();
        args.Source(&mut uri)?;
        if webview2_com::take_pwstr(uri) != ORIGIN { return Ok(()); }
        let mut body = PWSTR::null();
        if args.TryGetWebMessageAsString(&mut body).is_err() { return Ok(()); }
        let body = webview2_com::take_pwstr(body);
        let Some(id) = body.strip_prefix("pilot-drop:").filter(|id| valid_key(id)) else { return Ok(()); };
        let result = (|| -> Result<()> {
            let collection = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()?.AdditionalObjects()?;
            let mut count = 0;
            collection.Count(&mut count)?;
            let mut entries = Vec::new();
            for index in 0..count {
                let file = collection.GetValueAtIndex(index)?.cast::<ICoreWebView2File>()?;
                let mut raw = PWSTR::null();
                file.Path(&mut raw)?;
                let path = PathBuf::from(webview2_com::take_pwstr(raw));
                if !path.is_absolute() { return Err("Virtual drop".into()); }
                let folder = fs::metadata(&path)?.is_dir();
                let path = HSTRING::from(path.as_os_str());
                let key = bookmark(&root, &path, folder)?;
                entries.push((path, folder, key));
            }
            if entries.is_empty() { return Err("Empty drop".into()); }
            send_handles(&sender, &environment, &entries, id)
        })();
        if result.is_err() { picker_error(&sender, id); }
        Ok(())
    }));
    let mut token = 0;
    unsafe { core.add_WebMessageReceived(&listener, &mut token)?; }
    Ok(())
}

fn message(message: &str) {
    let text = HSTRING::from(message);
    unsafe { MessageBoxW(None, &text, w!("Station Pilot"), MB_OK | MB_ICONERROR); }
}

fn uninstall() -> Result<()> {
    let choice = unsafe {
        MessageBoxW(None, w!("Remove Station Pilot's saved audio, queue, settings, and history?\n\nYes removes the data. No keeps it for reinstall."),
            w!("Uninstall Station Pilot"), MB_YESNOCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2)
    };
    if choice == IDCANCEL {
        return Ok(());
    }
    let system = PathBuf::from(env::var_os("SystemRoot").ok_or("Windows system folder unavailable")?);
    let mut installer = Command::new(system.join("System32/msiexec.exe"));
    installer.args(["/x", PRODUCT]);
    if choice == IDYES {
        installer.arg("PURGEDATA=1");
    }
    installer.spawn()?;
    Ok(())
}

fn run() -> Result<()> {
    let mode = env::args().nth(1);
    let (install, data) = paths()?;
    let user = current_user()?;
    let named = |suffix: &str| HSTRING::from(format!("Local\\StationPilot{suffix}-{user}"));
    let show = Handle(unsafe { CreateEventW(None, false, false, &named("-Show"))? });
    let mutex = Handle(unsafe { CreateMutexW(None, false, &named(""))? });
    let waiting = if mode.is_some() { 2500 } else { 0 };
    let lock = unsafe { WaitForSingleObject(mutex.0, waiting) };
    if lock != WAIT_OBJECT_0 && lock != WAIT_ABANDONED {
        unsafe { windows::Win32::System::Threading::SetEvent(show.0)?; }
        return if mode.is_some() { Err("Close Station Pilot before uninstalling.".into()) } else { Ok(()) };
    }

    match mode.as_deref() {
        Some("--purge") => {
            if data.exists() {
                fs::remove_dir_all(data)?;
            }
            unsafe { ReleaseMutex(mutex.0)? };
            return Ok(());
        }
        Some("--uninstall") => {
            uninstall()?;
            unsafe { ReleaseMutex(mutex.0)? };
            return Ok(());
        }
        _ => {}
    }

    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(w!("org.stationpilot.workstation")) };
    let stop = Handle(unsafe { CreateEventW(None, true, false, &named("-Stop"))? });
    configure_runtime(&install)?;
    let profile = data.join("WebView");
    migrate_library(&data, &profile)?;
    let stop_handle = stop.0.0 as usize;
    let show_handle = show.0.0 as usize;
    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse()?))
                .title("Station Pilot").inner_size(1280.0, 850.0).min_inner_size(560.0, 480.0)
                .data_directory(profile).disable_drag_drop_handler()
                .additional_browser_args("--disable-background-networking --disable-background-timer-throttling --disable-renderer-backgrounding --disk-cache-size=16777216 --autoplay-policy=no-user-gesture-required --disable-features=HardwareMediaKeyHandling")
                .initialization_script(if cfg!(feature = "offline") { "" } else { "window.stationPilotInAppUpdates = true;" })
                .on_navigation(|url| url.as_str() == ORIGIN || url.as_str() == "about:blank")
                .build()?;
            let dock = crate::dock::Dock::attach(&window, data.clone())?;
            let owner = window.hwnd()?.0 as usize;
            let window_copy = window.clone();
            window.with_webview(move |platform| {
                let setup = || -> Result<()> { unsafe {
                    let core = platform.controller().CoreWebView2()?;
                    attach_assets(&core)?;
                    let picker = core.cast::<ICoreWebView2_23>()?;
                    let environment = core.cast::<ICoreWebView2_2>()?.Environment()?.cast::<ICoreWebView2Environment14>()?;
                    let root = data.join("MusicLinks");
                    register_drops(picker.clone(), environment.clone(), root.clone())?;
                    let updater = crate::windows_update::Updater::new(window_copy.clone(), &data);
                    let media = crate::windows_media::WindowsMedia::attach(&window_copy, HWND(owner as *mut _)).ok();
                    let listener = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut source = PWSTR::null();
                        args.Source(&mut source)?;
                        if webview2_com::take_pwstr(source) != ORIGIN { return Ok(()) }
                        let mut raw = PWSTR::null();
                        if args.TryGetWebMessageAsString(&mut raw).is_err() { return Ok(()) }
                        let body = webview2_com::take_pwstr(raw);
                        match body.as_str() {
                            value if value.starts_with("dock:") => {
                                #[derive(serde::Deserialize)]
                                struct DockMessage { id: String, request: crate::dock::Command }
                                if let Ok(message) = serde_json::from_str::<DockMessage>(&value[5..]) {
                                    let result = dock.execute(message.request);
                                    let response = match result {
                                        Ok(value) => serde_json::json!({"type":"pilot-dock","id":message.id,"value":value}),
                                        Err(error) => serde_json::json!({"type":"pilot-dock","id":message.id,"error":error}),
                                    };
                                    picker.PostWebMessageAsJson(&HSTRING::from(response.to_string()))?;
                                }
                            }
                            value if value.starts_with("audio-access:") => {
                                if let Ok(request) = serde_json::from_str(&value["audio-access:".len()..]) {
                                    change_audio_access(&picker, request);
                                }
                            }
                            value if value.starts_with("media-playback:") => {
                                if let (Some(media), Ok(playback)) = (
                                    &media, serde_json::from_str::<Option<crate::windows_media::Playback>>(&value["media-playback:".len()..])
                                ) {
                                    let _ = media.publish(playback);
                                }
                            }
                            value if value.starts_with("install-update:") => {
                                if let Ok(request) = serde_json::from_str(&value["install-update:".len()..]) {
                                    updater.handle(request);
                                }
                            }
                            "pilot-ready" => picker.PostWebMessageAsJson(w!(r#"{"type":"pilot-picker-ready"}"#))?,
                            "pick-folder" | "pick-audio" => {
                                let folders = body == "pick-folder";
                                let root = root.clone();
                                let wnd = window_copy.clone();
                                // Defer modal dialogs until the WebView message callback returns.
                                std::thread::spawn(move || {
                                    let _ = wnd.with_webview(move |web| {
                                        if let Ok(core) = web.controller().CoreWebView2() {
                                            let result = (|| -> Result<()> {
                                                let env = core.cast::<ICoreWebView2_2>()?.Environment()?.cast()?;
                                                post_media(&core.cast()?, &env, HWND(owner as *mut _), folders, &root)
                                            })();
                                            if result.is_err() { picker_error(&core, "picker"); }
                                        }
                                    });
                                });
                            }
                            message if message.starts_with("save-settings:") => {
                                let request = serde_json::from_str::<SettingsExport>(&message["save-settings:".len()..]);
                                let wnd = window_copy.clone();
                                // Run the modal picker after returning from WebMessageReceived.
                                std::thread::spawn(move || {
                                    let _ = wnd.with_webview(move |web| {
                                        let Ok(core) = web.controller().CoreWebView2() else { return };
                                        let result = request.map_err(|error| error.into())
                                            .and_then(|request| save_settings_export(HWND(owner as *mut _), request));
                                        let payload = match result {
                                            Ok(saved) => serde_json::json!({"type":"pilot-settings-export","saved":saved}),
                                            Err(error) => serde_json::json!({"type":"pilot-settings-export","error":error.to_string()}),
                                        };
                                        let _ = core.PostWebMessageAsJson(&HSTRING::from(payload.to_string()));
                                    });
                                });
                            }
                            "open-donation" | "open-volume-mixer" | "open-releases" => {
                                let link = match body.as_str() {
                                    "open-donation" => "https://ko-fi.com/bitwraith21",
                                    "open-volume-mixer" => "ms-settings:apps-volume",
                                    _ => crate::RELEASES_URL,
                                };
                                ShellExecuteW(None, w!("open"), &HSTRING::from(link), None, None, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL);
                            }
                            _ => if let Some(key) = body.strip_prefix("restore:").filter(|key| valid_key(key)) {
                                if restore(&root, key).and_then(|entry| send_handles(&picker, &environment, &[entry], key)).is_err() {
                                    picker_error(&picker, key);
                                }
                            }
                        }
                        Ok(())
                    }));
                    let mut token = 0;
                    core.add_WebMessageReceived(&listener, &mut token)?;
                    core.Navigate(&HSTRING::from(ORIGIN))?;
                    Ok(())
                }};
                if let Err(error) = setup() { message(&error.to_string()); std::process::exit(1); }
            })?;
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                if unsafe { WaitForSingleObject(HANDLE(stop_handle as *mut _), 150) } == WAIT_OBJECT_0 {
                    handle.exit(0);
                    break;
                }
                if unsafe { WaitForSingleObject(HANDLE(show_handle as *mut _), 0) } == WAIT_OBJECT_0 {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            });
            Ok(())
        }).build(tauri::generate_context!())?;
    app.run(|_, _| {});
    drop((stop, show, mutex));
    Ok(())
}

pub fn main() {
    if let Err(error) = run() {
        if env::args().nth(1).as_deref() != Some("--purge") {
            message(&error.to_string());
        }
        std::process::exit(1);
    }
}
