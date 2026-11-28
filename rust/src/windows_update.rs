use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::c_void,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    ptr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use windows::{
    core::{w, Error, HSTRING, PCWSTR},
    Win32::Networking::WinHttp::*,
};

const REPOSITORY: &str = "bitwraith21/station-pilot";
const MAX_INSTALLER_SIZE: u64 = 128 * 1024 * 1024;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn fail(message: &str) -> io::Error {
    io::Error::other(message)
}

struct HttpHandle(*mut c_void);

impl HttpHandle {
    fn new(handle: *mut c_void) -> windows::core::Result<Self> {
        if handle.is_null() {
            Err(Error::from_thread())
        } else {
            Ok(Self(handle))
        }
    }
}

impl Drop for HttpHandle {
    fn drop(&mut self) {
        let _ = unsafe { WinHttpCloseHandle(self.0) };
    }
}

fn fetch(
    host: &HSTRING,
    path: &HSTRING,
    mut receive: impl FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    let (_session, _connection, request) = unsafe {
        let session = HttpHandle::new(WinHttpOpen(
            w!("Station-Pilot-Updater"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?;
        WinHttpSetTimeouts(session.0, 10000, 10000, 10000, 15000)?;
        let connection = HttpHandle::new(WinHttpConnect(session.0, host, 443, 0))?;
        let request = HttpHandle::new(WinHttpOpenRequest(
            connection.0,
            w!("GET"),
            path,
            PCWSTR::null(),
            PCWSTR::null(),
            ptr::null(),
            WINHTTP_FLAG_SECURE,
        ))?;
        let mut status = 0u32;
        let mut length = 4u32;
        WinHttpSendRequest(request.0, None, None, 0, 0, 0)?;
        WinHttpReceiveResponse(request.0, ptr::null_mut())?;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut length,
            ptr::null_mut(),
        )?;
        if status != 200 {
            return Err(fail(&format!("GitHub returned HTTP {status}.")).into());
        }
        (session, connection, request)
    };
    let mut buffer = [0u8; 64 * 1024];
    let started = Instant::now();
    loop {
        if started.elapsed() > Duration::from_secs(180) {
            return Err(fail("The update download timed out.").into());
        }
        let mut read = 0;
        unsafe {
            WinHttpReadData(
                request.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut read,
            )?
        };
        if read == 0 {
            return Ok(());
        }
        receive(&buffer[..read as usize])?;
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    digest: Option<String>,
    size: u64,
}

fn version(tag: &str) -> Option<[u32; 3]> {
    let mut parts = tag.strip_prefix('v').unwrap_or(tag).split('.');
    let parsed = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(parsed)
}

fn release_asset(tag: &str) -> Result<(Asset, String, String)> {
    let parsed = version(tag).ok_or_else(|| fail("Invalid update version."))?;
    if Some(parsed) <= version(env!("CARGO_PKG_VERSION")) {
        return Err(fail("This release is already installed or older than this app.").into());
    }
    let [major, minor, patch] = parsed;
    let numeric = format!("{major}.{minor}.{patch}");
    if tag != numeric && tag != format!("v{numeric}") {
        return Err(fail("Invalid update tag.").into());
    }
    let mut payload = Vec::new();
    fetch(
        &HSTRING::from("api.github.com"),
        &HSTRING::from(format!("/repos/{REPOSITORY}/releases/tags/{tag}")),
        |bytes| {
            if payload.len() + bytes.len() > 1024 * 1024 {
                return Err(fail("Release information exceeds the expected size.").into());
            }
            payload.extend_from_slice(bytes);
            Ok(())
        },
    )?;
    let release: Release = serde_json::from_slice(&payload)?;
    if release.tag_name != tag || release.draft || release.prerelease {
        return Err(fail("This release is unavailable for in-app installation.").into());
    }
    for suffix in ["-Windows-x64-Small.msi", "-Windows-x64.msi"] {
        let name = format!("Station-Pilot-{numeric}{suffix}");
        let path = format!("/{REPOSITORY}/releases/download/{tag}/{name}");
        if let Some(index) = release.assets.iter().position(|asset| {
            asset.name == name
                && asset.browser_download_url == format!("https://github.com{path}")
                && (1..=MAX_INSTALLER_SIZE).contains(&asset.size)
                && asset.digest.as_deref().is_some_and(|hash| {
                    hash.strip_prefix("sha256:").is_some_and(|hex| {
                        hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
                    })
                })
        }) {
            let mut assets = release.assets;
            let asset = assets.swap_remove(index);
            let hash = asset.digest.as_deref().unwrap()["sha256:".len()..].to_ascii_lowercase();
            return Ok((asset, path, hash));
        }
    }
    Err(fail("This release has no Windows x64 installer with a GitHub SHA-256 checksum.").into())
}

fn download(tag: &str, path: &Path, mut progress: impl FnMut(u64, u64)) -> Result<()> {
    let (asset, source, expected) = release_asset(tag)?;
    let mut saved = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut last = Instant::now();
    progress(0, asset.size);
    fetch(
        &HSTRING::from("github.com"),
        &HSTRING::from(source),
        |bytes| {
            size += bytes.len() as u64;
            if size > asset.size {
                return Err(fail("The installer is larger than its listed size.").into());
            }
            saved.write_all(bytes)?;
            hash.update(bytes);
            if last.elapsed() >= Duration::from_millis(150) {
                progress(size, asset.size);
                last = Instant::now();
            }
            Ok(())
        },
    )?;
    let actual: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if size != asset.size || actual != expected {
        return Err(fail("The installer failed its SHA-256 verification.").into());
    }
    saved.sync_all()?;
    progress(size, asset.size);
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub(crate) enum UpdateRequest {
    Download { tag: String },
    Install,
}

enum State {
    Idle,
    Downloading,
    Ready(PathBuf),
    Installing,
}

pub(crate) struct Updater {
    window: tauri::WebviewWindow,
    parent: PathBuf,
    state: Arc<Mutex<State>>,
}

fn report(window: &tauri::WebviewWindow, update: serde_json::Value) {
    let _ = window.eval(format!("window.pilotUpdateStatus?.({update})"));
}

impl Updater {
    pub(crate) fn new(window: tauri::WebviewWindow, data: &Path) -> Self {
        let parent = data.join("Updates");
        Self {
            window,
            parent,
            state: Arc::new(Mutex::new(State::Idle)),
        }
    }

    pub(crate) fn handle(&self, request: UpdateRequest) {
        if cfg!(feature = "offline") {
            report(
                &self.window,
                serde_json::json!({"error":"Use the fixed-runtime installer from the release page for this edition."}),
            );
            return;
        }
        match request {
            UpdateRequest::Download { tag } => {
                let mut state = self.state.lock().unwrap();
                if matches!(*state, State::Downloading | State::Installing) {
                    return;
                }
                if let State::Ready(path) = &*state {
                    let _ = fs::remove_file(path);
                }
                *state = State::Downloading;
                drop(state);
                let destination = self.parent.join(format!(
                    "StationPilot-{}.msi",
                    uuid::Uuid::new_v4().simple()
                ));
                let window = self.window.clone();
                let state = self.state.clone();
                std::thread::spawn(move || {
                    let result = fs::create_dir_all(destination.parent().unwrap())
                        .map_err(Into::into)
                        .and_then(|_| {
                            download(&tag, &destination, |received, total| {
                                report(
                                    &window,
                                    serde_json::json!({"received":received,"total":total}),
                                );
                            })
                        });
                    let update = match result {
                        Ok(()) => {
                            *state.lock().unwrap() = State::Ready(destination);
                            serde_json::json!({"ready":true})
                        }
                        Err(error) => {
                            let _ = fs::remove_file(&destination);
                            *state.lock().unwrap() = State::Idle;
                            serde_json::json!({"error":error.to_string()})
                        }
                    };
                    report(&window, update);
                });
            }
            UpdateRequest::Install => {
                let mut state = self.state.lock().unwrap();
                let State::Ready(path) = &*state else { return };
                let result = env::var_os("SystemRoot")
                    .ok_or_else(|| fail("Windows system folder unavailable."))
                    .and_then(|root| {
                        Command::new(PathBuf::from(root).join("System32/msiexec.exe"))
                            .arg("/i")
                            .arg(path)
                            .args(["/passive", "/norestart", "PILOTUPDATE=1"])
                            .spawn()
                    });
                match result {
                    Ok(mut child) => {
                        *state = State::Installing;
                        let window = self.window.clone();
                        let state = self.state.clone();
                        std::thread::spawn(move || {
                            let message = match child.wait() {
                                Ok(status) if status.success() => "Installation completed. Open Station Pilot again if needed.".into(),
                                Ok(status) => format!("Windows Installer exited with code {}. See View release and downloads to install manually.", status.code().unwrap_or(0)),
                                Err(error) => error.to_string(),
                            };
                            *state.lock().unwrap() = State::Idle;
                            report(&window, serde_json::json!({"error":message}));
                        });
                    }
                    Err(error) => {
                        report(&self.window, serde_json::json!({"error":error.to_string()}))
                    }
                }
            }
        }
    }
}
