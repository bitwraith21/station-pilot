#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_host;
#[cfg(windows)]
mod windows_media;
#[cfg(windows)]
mod windows_update;
#[cfg(unix)]
mod unix_host;

mod dock;

const RELEASES_URL: &str = "https://github.com/bitwraith21/station-pilot/releases/latest";

const ASSETS: &[(&str, &str, &[u8])] = &[
    ("index.html", "text/html", include_bytes!("../../index.html")),
    ("style.css", "text/css", include_bytes!("../../style.css")),
    ("dock.js", "text/javascript", include_bytes!("../../dock.js")),
    ("app.js", "text/javascript", include_bytes!("../../app.js")),
    ("playout.js", "text/javascript", include_bytes!("../../playout.js")),
    ("storage.js", "text/javascript", include_bytes!("../../storage.js")),
    ("waveform.js", "text/javascript", include_bytes!("../../waveform.js")),
    ("covers.js", "text/javascript", include_bytes!("../../covers.js")),
    ("library_links.js", "text/javascript", include_bytes!("../../library_links.js")),
    ("limiter.js", "text/javascript", include_bytes!("../../limiter.js")),
    ("pilot_dsp.wasm", "application/wasm", include_bytes!("../../pilot_dsp.wasm")),
    ("icon.png", "image/png", include_bytes!("../../icon.png")),
];

fn main() {
    #[cfg(windows)]
    windows_host::main();
    #[cfg(unix)]
    unix_host::main();
}
