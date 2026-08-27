use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_store::StoreExt;
use tauri_plugin_wallpaper::{
    AttachRequest,
    PinRequest,
    WallpaperExt,
};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WallpaperOverlay {
    pub id: String,
    pub url: String,

    // Position is stored as a percentage of the wallpaper window.
    pub x: f32,
    pub y: f32,

    // Size is stored in pixels.
    pub width: f32,
    pub height: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSettings {
    pub wallpaper_type: String,
    pub wallpaper_src: String,

    pub autostart: bool,
    pub pause_on_battery: bool,
    pub pause_on_unfocus: bool,

    pub volume: f32,
    pub is_muted: bool,

    #[serde(default)]
    pub overlays: Vec<WallpaperOverlay>,
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

            overlays: Vec::new(),
        }
    }
}

/*
 * Reads persisted configuration from settings.json.
 */
#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    let store = app.store("settings.json").unwrap();

    if let Some(val) = store.get("config") {
        if let Ok(mut settings) =
            serde_json::from_value::<AppSettings>(val)
        {
            /*
             * Self-heal old/broken configs.
             *
             * blob: URLs only live inside the browser session that
             * created them. If an older version saved one, replace it
             * with the default wallpaper.
             */
            if settings.wallpaper_src.starts_with("blob:") {
                let defaults = AppSettings::default();

                settings.wallpaper_type =
                    defaults.wallpaper_type;
                settings.wallpaper_src =
                    defaults.wallpaper_src;

                store.set(
                    "config",
                    serde_json::to_value(&settings).unwrap(),
                );

                let _ = store.save();
            }

            return settings;
        }
    }

    AppSettings::default()
}

/*
 * Persists new configuration to settings.json.
 */
#[tauri::command]
fn update_settings(
    app: AppHandle,
    new_settings: AppSettings,
) -> Result<(), String> {
    let store = app
        .store("settings.json")
        .map_err(|e| e.to_string())?;

    /*
     * Update autostart behavior dynamically.
     */
    let autostart_mgr = app.autolaunch();

    if new_settings.autostart {
        let _ = autostart_mgr.enable();
    } else {
        let _ = autostart_mgr.disable();
    }

    /*
     * Write configuration immediately.
     */
    store.set(
        "config",
        serde_json::to_value(&new_settings)
            .map_err(|e| e.to_string())?,
    );

    store.save().map_err(|e| e.to_string())?;

    /*
     * Broadcast changes to every window.
     */
    let _ = app.emit(
        "settings-changed",
        new_settings,
    );

    Ok(())
}

/*
 * Checks Windows power status.
 */
#[tauri::command]
fn check_is_on_battery() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::mem::MaybeUninit;
        use winapi::um::winbase::{
            GetSystemPowerStatus,
            SYSTEM_POWER_STATUS,
        };

        unsafe {
            let mut status =
                MaybeUninit::<SYSTEM_POWER_STATUS>::uninit();

            if GetSystemPowerStatus(status.as_mut_ptr()) != 0 {
                let status = status.assume_init();

                return status.ACLineStatus == 0;
            }
        }
    }

    false
}

/*
 * Persists an uploaded local file to disk.
 *
 * Files are stored under:
 *
 * %APPDATA%/com.os.livewall/wallpapers/
 *
 * The returned path is converted to a Tauri asset URL by the frontend.
 */
#[tauri::command]
fn save_wallpaper_file(
    app: AppHandle,
    source_path: String,
) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let source = Path::new(&source_path);

    if !source.exists() {
        return Err(format!(
            "Wallpaper file does not exist: {}",
            source_path
        ));
    }

    if !source.is_file() {
        return Err(format!(
            "Wallpaper path is not a file: {}",
            source_path
        ));
    }

    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Could not determine wallpaper filename".to_string())?;

    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("wallpapers");

    fs::create_dir_all(&base_dir)
        .map_err(|e| e.to_string())?;

    /*
     * Sanitize the original filename.
     *
     * The native dialog already gives us a real filesystem path,
     * but we still don't want arbitrary path separators entering
     * our destination filename.
     */
    let safe_name = file_name
        .replace(['/', '\\'], "_")
        .replace("..", "_");

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    let destination = base_dir.join(format!(
        "{}_{}",
        timestamp,
        safe_name
    ));

    /*
     * IMPORTANT:
     *
     * The large file is copied directly by Rust.
     *
     * The WebView never receives the bytes.
     */
    fs::copy(source, &destination)
        .map_err(|e| {
            format!(
                "Failed to copy wallpaper: {}",
                e
            )
        })?;

    /*
     * Only remove old wallpapers AFTER the new file has
     * successfully been copied.
     *
     * This means a failed copy cannot destroy the currently
     * working wallpaper.
     */
    if let Ok(entries) = fs::read_dir(&base_dir) {
        for entry in entries.flatten() {
            let entry_path = entry.path();

            if entry_path != destination
                && entry_path.is_file()
            {
                let _ = fs::remove_file(entry_path);
            }
        }
    }

    Ok(destination
        .to_string_lossy()
        .to_string())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * WebView2 background throttling is problematic for a wallpaper
     * window because Windows considers it backgrounded/occluded.
     *
     * These flags prevent Chromium from suspending the wallpaper's
     * renderer and media playback.
     */
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--disable-background-timer-throttling \
         --disable-backgrounding-occluded-windows \
         --disable-renderer-backgrounding",
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin( tauri_plugin_wallpaper::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(
            tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--autostart"]),
            ),
        )
        .invoke_handler(
            tauri::generate_handler![
                get_settings,
                update_settings,
                check_is_on_battery,
                save_wallpaper_file
            ],
        )
        .setup(|app| {
            let handle = app.handle();

            /*
             * Attach the main window to the Windows desktop
             * wallpaper layer.
             *
             * IMPORTANT:
             *
             * The overlays are NOT separate windows.
             * They are iframes inside this exact same window.
             *
             * Therefore Windows treats the wallpaper + all overlays
             * as one desktop-layer window.
             */
            let _ = handle
                .wallpaper()
                .attach(
                    AttachRequest::new("main"),
                );

            let _ = handle
                .wallpaper()
                .pin(
                    PinRequest::new("main"),
                );

            /*
             * Windows can recreate WorkerW after:
             *
             * - Explorer restarts
             * - waking from sleep
             * - display changes
             * - resolution changes
             * - DPI changes
             *
             * Reattach periodically so the wallpaper can recover.
             */
            let watchdog_handle = handle.clone();

            std::thread::spawn(move || loop {
                std::thread::sleep(
                    std::time::Duration::from_secs(60),
                );

                let _ = watchdog_handle
                    .wallpaper()
                    .attach(
                        AttachRequest::new("main"),
                    );

                let _ = watchdog_handle
                    .wallpaper()
                    .pin(
                        PinRequest::new("main"),
                    );
            });

            /*
             * System tray menu.
             */
            let settings_item =
                MenuItem::with_id(
                    app,
                    "settings",
                    "Settings",
                    true,
                    None::<&str>,
                )?;

            let quit_item =
                MenuItem::with_id(
                    app,
                    "quit",
                    "Quit",
                    true,
                    None::<&str>,
                )?;

            let menu =
                Menu::with_items(
                    app,
                    &[
                        &settings_item,
                        &quit_item,
                    ],
                )?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .unwrap()
                        .clone(),
                )
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(
                    move |app, event| {
                        match event.id.as_ref() {
                            "settings" => {
                                if let Some(window) =
                                    app.get_webview_window(
                                        "settings",
                                    )
                                {
                                    let _ =
                                        window.show();

                                    let _ =
                                        window.set_focus();
                                } else {
                                    let _ =
                                        WebviewWindowBuilder::new(
                                            app,
                                            "settings",
                                            WebviewUrl::App(
                                                "index.html?settings=true"
                                                    .into(),
                                            ),
                                        )
                                        .title(
                                            "Wallpaper Settings",
                                        )
                                        .inner_size(
                                            420.0,
                                            600.0,
                                        )
                                        .resizable(true)
                                        .center()
                                        .build();
                                }
                            }

                            "quit" => {
                                std::process::exit(0);
                            }

                            _ => {}
                        }
                    },
                )
                .build(app)?;

            Ok(())
        })
        .run(
            tauri::generate_context!(),
        )
        .expect(
            "error while running tauri application",
        );
}