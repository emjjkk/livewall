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
    pub wallpaper_type: String,
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
            wallpaper_src:
                "https://images.unsplash.com/photo-1707343843437-caacff5cfa74?q=80&w=1920".into(),
            autostart: false,
            pause_on_battery: false,
            pause_on_unfocus: false,
            volume: 1.0,
            is_muted: false,
        }
    }
}

// Read settings from disk
#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    let store = app.store("settings.json").unwrap();
    if let Some(val) = store.get("config") {
        if let Ok(settings) = serde_json::from_value::<AppSettings>(val) {
            return settings;
        }
    }
    AppSettings::default()
}

// Write settings to disk
#[tauri::command]
fn update_settings(app: AppHandle, new_settings: AppSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    // Handle autostart changes
    let autostart_mgr = app.autolaunch();
    if new_settings.autostart {
        let _ = autostart_mgr.enable();
    } else {
        let _ = autostart_mgr.disable();
    }

    // Persist JSON configuration to disk
    store.set("config", serde_json::to_value(&new_settings).unwrap());
    let _ = store.save(); // Save to local storage

    // Sync across open webviews
    let _ = app.emit("settings-changed", new_settings);
    Ok(())
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            check_is_on_battery
        ])
        .setup(|app| {
            let handle = app.handle();

            // Pin to wallpaper layer
            let _ = handle.wallpaper().attach(AttachRequest::new("main"));
            let _ = handle.wallpaper().pin(PinRequest::new("main"));

            // Tray Menu Setup
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "settings" => {
                        if let Some(window) = app.get_webview_window("settings") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "settings",
                                WebviewUrl::App("index.html?settings=true".into()), // Explicit param
                            )
                            .title("Wallpaper Settings")
                            .inner_size(420.0, 560.0)
                            .resizable(false)
                            .center()
                            .build();
                        }
                    }
                    "quit" => std::process::exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
