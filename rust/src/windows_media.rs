use serde::Deserialize;
use windows::{
    core::{factory, HSTRING, Result},
    Foundation::TypedEventHandler,
    Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsButtonPressedEventArgs,
    },
    Win32::{Foundation::HWND, System::WinRT::ISystemMediaTransportControlsInterop},
};

#[derive(Deserialize)]
pub(crate) struct Playback {
    title: String,
    artist: String,
    playing: bool,
}

pub(crate) struct WindowsMedia {
    controls: SystemMediaTransportControls,
    handler_token: i64,
}

impl WindowsMedia {
    pub(crate) fn attach(window: &tauri::WebviewWindow, owner: HWND) -> Result<Self> {
        let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
        let controls: SystemMediaTransportControls = unsafe { interop.GetForWindow(owner)? };
        controls.SetIsEnabled(false)?;
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;

        let window = window.clone();
        let pressed = TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(move |_, args| {
            let Some(args) = args.as_ref() else { return Ok(()) };
            let script = match args.Button()? {
                SystemMediaTransportControlsButton::Play => "window.pilotMediaAction?.(true)",
                SystemMediaTransportControlsButton::Pause => "window.pilotMediaAction?.(false)",
                _ => return Ok(()),
            };
            let _ = window.eval(script);
            Ok(())
        });
        let handler_token = controls.ButtonPressed(&pressed)?;
        Ok(Self { controls, handler_token })
    }

    pub(crate) fn publish(&self, playback: Option<Playback>) -> Result<()> {
        let Some(playback) = playback else {
            self.controls.SetPlaybackStatus(MediaPlaybackStatus::Stopped)?;
            return self.controls.SetIsEnabled(false);
        };
        let display = self.controls.DisplayUpdater()?;
        display.SetType(MediaPlaybackType::Music)?;
        let music = display.MusicProperties()?;
        music.SetTitle(&HSTRING::from(playback.title))?;
        music.SetArtist(&HSTRING::from(playback.artist))?;
        display.Update()?;
        self.controls.SetPlaybackStatus(if playback.playing {
            MediaPlaybackStatus::Playing
        } else {
            MediaPlaybackStatus::Paused
        })?;
        self.controls.SetIsEnabled(true)
    }
}

impl Drop for WindowsMedia {
    fn drop(&mut self) {
        let _ = self.controls.RemoveButtonPressed(self.handler_token);
        let _ = self.controls.SetIsEnabled(false);
    }
}
