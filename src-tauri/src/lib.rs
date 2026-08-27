use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_store::StoreExt;
use tauri_plugin_wallpaper::{AttachRequest, PinRequest, WallpaperExt};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub wallpaper_type: String, // "image" | "video" | "webpage"
    pub wallpaper_src: String,
    pub autostart: bool,
    pub pause_on_battery: bool,
    pub pause_on_unfocus: bool,
    pub volume: f32,
    pub is_muted: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            wallpaper_type: "image".into(),
            wallpaper_src: "https://images.unsplash.com/photo-1707343843437-caacff5cfa74?q=80&w=1920".into(),
            autostart: false,
            pause_on_battery: false,
            pause_on_unfocus: false,
            volume: 1.0,
            is_muted: false,
        }
    }
}

// Inter-process command: Reads persisted configuration from settings.json
#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    let store = app.store("settings.json").unwrap();
    if let Some(val) = store.get("config") {
        if let Ok(mut settings) = serde_json::from_value::<AppSettings>(val) {
            // Self-heal old/broken configs: `blob:` URLs only ever live inside the
            // browser session that created them, so one saved to disk can never be
            // valid again once the app restarts (e.g. after a PC reboot). Without
            // this, a wallpaper set from an uploaded file would silently fail to
            // load forever, even though autostart is working correctly.
            if settings.wallpaper_src.starts_with("blob:") {
                let defaults = AppSettings::default();
                settings.wallpaper_type = defaults.wallpaper_type;
                settings.wallpaper_src = defaults.wallpaper_src;
                store.set("config", serde_json::to_value(&settings).unwrap());
                let _ = store.save();
            }
            return settings;
        }
    }
    AppSettings::default()
}

// Inter-process command: Persists new configuration to settings.json
#[tauri::command]
fn update_settings(app: AppHandle, new_settings: AppSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    // Update autostart behavior dynamically
    let autostart_mgr = app.autolaunch();
    if new_settings.autostart {
        let _ = autostart_mgr.enable();
    } else {
        let _ = autostart_mgr.disable();
    }

    // Write to disk immediately
    store.set("config", serde_json::to_value(&new_settings).unwrap());
    let _ = store.save();

    // Broadcast update across windows (Settings & Main)
    let _ = app.emit("settings-changed", new_settings);
    Ok(())
}

// Inter-process command: Checks Windows power status (AC vs Battery)
#[tauri::command]
fn check_is_on_battery() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::mem::MaybeUninit;
        use winapi::um::winbase::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

        unsafe {
            let mut status = MaybeUninit::<SYSTEM_POWER_STATUS>::uninit();
            if GetSystemPowerStatus(status.as_mut_ptr()) != 0 {
                let status = status.assume_init();
                return status.ACLineStatus == 0;
            }
        }
    }
    false
}

// Inter-process command: Persists an uploaded local file (image/video) to disk
// under the app's data directory and returns its absolute path. Local files
// picked in Settings used to be referenced via a `blob:` object URL, which is
// only valid for the lifetime of the webview that created it - it silently
// breaks the moment the app restarts. Writing the bytes to a real file on disk
// (served back to the frontend through Tauri's asset protocol via
// convertFileSrc) makes the wallpaper survive restarts, including via
// autostart.
#[tauri::command]
fn save_wallpaper_file(app: AppHandle, file_name: String, data: Vec<u8>) -> Result<String, String> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("wallpapers");

    std::fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    // Strip path separators / traversal attempts from the original file name
    let safe_name = file_name.replace(['/', '\\'], "_").replace("..", "_");

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let file_path = base_dir.join(format!("{}_{}", timestamp, safe_name));
    std::fs::write(&file_path, data).map_err(|e| e.to_string())?;

    // Remove previously saved wallpaper files so old uploads don't pile up on disk
    if let Ok(entries) = std::fs::read_dir(&base_dir) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path != file_path {
                let _ = std::fs::remove_file(entry_path);
            }
        }
    }

    Ok(file_path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Chromium/WebView2 throttles timers and can suspend media playback on
    // windows it considers backgrounded or occluded - which describes our
    // wallpaper window perfectly, since it always sits behind the desktop
    // icons and is frequently covered by other apps. Left unchecked, this is
    // why video wallpapers appear to "stop playing after some time". These
    // flags tell WebView2 not to apply that throttling.
    //
    // Trade-off: this also disables throttling when the window is covered by
    // *other real application windows* (not just desktop icons), so it won't
    // get the free CPU/GPU savings Chromium would otherwise give an occluded
    // renderer in that case. The `pause_on_unfocus` setting is the intended
    // substitute for that - worth confirming it actually fires for this
    // window (see note in App.tsx).
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding",
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_wallpaper::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            check_is_on_battery,
            save_wallpaper_file
        ])
        .setup(|app| {
            let handle = app.handle();

            // Attach main window to desktop wallpaper layer (behind icons)
            let _ = handle.wallpaper().attach(AttachRequest::new("main"));
            let _ = handle.wallpaper().pin(PinRequest::new("main"));

            // Windows periodically recreates the desktop's WorkerW layer - e.g.
            // after waking from sleep, changing resolution/DPI, or explorer.exe
            // restarting - which detaches our window from behind the desktop
            // icons and makes the wallpaper appear to freeze or vanish. Re-attach
            // and re-pin on an interval so it keeps recovering on its own instead
            // of staying broken until the app is manually restarted. 60s instead
            // of 30s - this is a recovery net, not something that needs to react
            // within half a minute, and it halves the thread's wake-ups.
            let watchdog_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let _ = watchdog_handle.wallpaper().attach(AttachRequest::new("main"));
                let _ = watchdog_handle.wallpaper().pin(PinRequest::new("main"));
            });

            // Create System Tray Menu
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            // Spawn Settings Window with explicit search query string flag
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "settings",
                                WebviewUrl::App("index.html?settings=true".into()),
                            )
                            .title("Wallpaper Settings")
                            .inner_size(420.0, 560.0)
                            .resizable(false)
                            .center()
                            .build();
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {},
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}