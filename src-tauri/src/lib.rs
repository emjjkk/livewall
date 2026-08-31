use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

const WIDGET_LINK_SCRIPT: &str = r#"
(function () {
    function isHttpUrl(url) {
        return /^https?:\/\//i.test(url);
    }

    document.addEventListener(
        "click",
        function (event) {
            var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
            if (!anchor) return;

            var href = anchor.href;
            if (!isHttpUrl(href)) return;

            event.preventDefault();
            event.stopPropagation();

            try {
                top.location.href = href;
            } catch (err) {
                /* blocked cross-origin top nav, nothing more we can do */
            }
        },
        true,
    );

    var originalOpen = window.open;
    window.open = function (url) {
        if (url && isHttpUrl(url)) {
            try { top.location.href = url; } catch (err) {}
            return null;
        }
        return originalOpen ? originalOpen.apply(window, arguments) : null;
    };
})();
"#;

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
            wallpaper_src:
                "https://images.unsplash.com/photo-1707343843437-caacff5cfa74?q=80&w=1920".into(),

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
        if let Ok(mut settings) = serde_json::from_value::<AppSettings>(val) {
            /*
             * blob: URLs only exist inside the browser session that
             * created them. If an older version saved one, restore
             * the default wallpaper.
             */
            if settings.wallpaper_src.starts_with("blob:") {
                let defaults = AppSettings::default();

                settings.wallpaper_type = defaults.wallpaper_type;
                settings.wallpaper_src = defaults.wallpaper_src;

                let _ = store.set("config", serde_json::to_value(&settings).unwrap());

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
fn update_settings(app: AppHandle, new_settings: AppSettings) -> Result<(), String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;

    /*
     * Update autostart immediately.
     */
    let autostart_mgr = app.autolaunch();

    if new_settings.autostart {
        let _ = autostart_mgr.enable();
    } else {
        let _ = autostart_mgr.disable();
    }

    /*
     * Persist configuration immediately.
     */
    store.set(
        "config",
        serde_json::to_value(&new_settings).map_err(|e| e.to_string())?,
    );

    store.save().map_err(|e| e.to_string())?;

    /*
     * Broadcast the new configuration to every window.
     */
    let _ = app.emit("settings-changed", new_settings);

    Ok(())
}

/*
 * Checks whether Windows currently reports the system as being
 * on battery power.
 */
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

/*
 * Determines whether the Windows desktop is currently active.
 *
 * This deliberately does NOT use document.hasFocus().
 *
 * A wallpaper window lives behind the desktop and its focus state
 * can change when WebView2/iframes receive input. Windows' native
 * foreground window is therefore a much better source of truth.
 */
#[tauri::command]
fn is_desktop_focused(app: AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    {
        use windows::{
            core::w,
            Win32::{
                Foundation::HWND,
                UI::WindowsAndMessaging::{
                    FindWindowW, GetDesktopWindow, GetForegroundWindow, GetShellWindow,
                },
            },
        };

        unsafe {
            let foreground = GetForegroundWindow();

            if foreground == HWND::default() {
                return false;
            }

            /*
             * If the wallpaper itself currently has focus, consider
             * that equivalent to desktop focus.
             *
             * The wallpaper plugin temporarily gives the wallpaper
             * real focus so keyboard input can work.
             */
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(hwnd) = window.hwnd() {
                    if hwnd == foreground {
                        return true;
                    }
                }
            }

            /*
             * Standard desktop handles.
             */
            if foreground == GetDesktopWindow() {
                return true;
            }

            if foreground == GetShellWindow() {
                return true;
            }

            /*
             * Windows may use Progman or WorkerW as the active
             * desktop window depending on the shell configuration.
             */
            if let Ok(progman) = FindWindowW(w!("Progman"), None) {
                if progman == foreground {
                    return true;
                }
            }

            if let Ok(workerw) = FindWindowW(w!("WorkerW"), None) {
                if workerw == foreground {
                    return true;
                }
            }
        }
    }

    false
}

/*
 * Copies an uploaded wallpaper directly from the source filesystem
 * path into Livewall's application data directory.
 *
 * The video/image bytes never travel through JavaScript.
 */
#[tauri::command]
fn save_wallpaper_file(app: AppHandle, source_path: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let source = Path::new(&source_path);

    if !source.exists() {
        return Err(format!("Wallpaper file does not exist: {}", source_path));
    }

    if !source.is_file() {
        return Err(format!("Wallpaper path is not a file: {}", source_path));
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

    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;

    /*
     * Sanitize the original filename.
     */
    let safe_name = file_name.replace(['/', '\\'], "_").replace("..", "_");

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);

    let destination = base_dir.join(format!("{}_{}", timestamp, safe_name));

    /*
     * Copy directly from disk.
     */
    fs::copy(source, &destination).map_err(|e| format!("Failed to copy wallpaper: {}", e))?;

    /*
     * Only remove old wallpapers AFTER the new wallpaper has
     * successfully been copied.
     */
    if let Ok(entries) = fs::read_dir(&base_dir) {
        for entry in entries.flatten() {
            let entry_path = entry.path();

            if entry_path != destination && entry_path.is_file() {
                let _ = fs::remove_file(entry_path);
            }
        }
    }

    Ok(destination.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * WebView2 normally throttles renderers that it considers
     * backgrounded or occluded.
     *
     * A wallpaper is intentionally behind other windows, so disable
     * those throttles. The plugin's occlusion monitor handles actual
     * fullscreen applications separately.
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
        .plugin(tauri_plugin_wallpaper::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            check_is_on_battery,
            is_desktop_focused,
            save_wallpaper_file
        ])
        .setup(|app| {
            /*
             * The wallpaper plugin now owns wallpaper attachment
             * and Explorer restart recovery.
             *
             * Input forwarding is configured from the frontend
             * because the JS API exposes the forwarding options.
             */
            let _ = app.get_webview_window("main");

            /*
             * System tray.
             */
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;

            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(app, &[&settings_item, &quit_item])?;

            /*
             * The main wallpaper window is configured with `"create": false`
             * so we can install navigation handlers before WebView2 is created.
             *
             * This is important for widgets:
             *
             *   <a href="https://example.com">
             *
             * should not navigate the Livewall application itself.
             *
             * If the main webview receives an external top-level navigation,
             * cancel it and open the URL using the user's default browser.
             */
            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or_else(|| "Could not find the main window configuration".to_string())?
                .clone();

            WebviewWindowBuilder::from_config(app, &main_window_config)?
                .initialization_script_for_all_frames(WIDGET_LINK_SCRIPT)
                .on_navigation({
                    let app_handle = app.handle().clone();

                    move |url| {
                        let scheme = url.scheme();

                        /*
                         * Allow Livewall's own application URL.
                         */
                        if scheme == "tauri" {
                            return true;
                        }

                        /*
                         * Allow the Vite development server.
                         */
                        if cfg!(dev) && scheme == "http" && url.host_str() == Some("localhost") {
                            return true;
                        }

                        /*
                         * Any external HTTP/HTTPS navigation should be opened
                         * by the operating system instead of navigating the
                         * Livewall window itself.
                         */
                        if scheme == "http" || scheme == "https" {
                            let url_string = url.as_str().to_string();

                            if let Err(error) =
                                app_handle.opener().open_url(&url_string, None::<&str>)
                            {
                                eprintln!(
                                    "Failed to open external URL '{}': {}",
                                    url_string, error
                                );
                            }

                            return false;
                        }

                        /*
                         * Allow normal browser protocols that are useful for
                         * links, such as mailto: and tel:.
                         *
                         * These are still opened externally.
                         */
                        if matches!(scheme, "mailto" | "tel" | "sms") {
                            let url_string = url.as_str().to_string();

                            if let Err(error) =
                                app_handle.opener().open_url(&url_string, None::<&str>)
                            {
                                eprintln!(
                                    "Failed to open external URL '{}': {}",
                                    url_string, error
                                );
                            }

                            return false;
                        }

                        /*
                         * Unknown protocols are rejected rather than allowing
                         * arbitrary protocol handlers to be launched.
                         */
                        false
                    }
                })
                .on_new_window({
                    let app_handle = app.handle().clone();

                    move |url, _features| {
                        /*
                         * Links using target="_blank" and window.open() arrive
                         * here.
                         *
                         * Instead of creating another Tauri window, open them
                         * using the system's default browser.
                         */
                        let url_string = url.as_str().to_string();

                        if matches!(url.scheme(), "http" | "https" | "mailto" | "tel" | "sms") {
                            if let Err(error) =
                                app_handle.opener().open_url(&url_string, None::<&str>)
                            {
                                eprintln!(
                                    "Failed to open external URL '{}': {}",
                                    url_string, error
                                );
                            }
                        }

                        /*
                         * Do not create another WebView window.
                         */
                        tauri::webview::NewWindowResponse::Deny
                    }
                })
                .build()?;

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
                            let _ = WebviewWindowBuilder::new(
                                app,
                                "settings",
                                WebviewUrl::App("index.html?settings=true".into()),
                            )
                            .title("Wallpaper Settings")
                            .inner_size(420.0, 600.0)
                            .resizable(true)
                            .center()
                            .build();
                        }
                    }

                    "quit" => {
                        std::process::exit(0);
                    }

                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Livewall");
}
