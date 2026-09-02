use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
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

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WallpaperOverlay {
    pub id: String,
    pub url: String,

    // Position is stored as a percentage of the wallpaper window.
    pub x: f32,
    pub y: f32,

    // Size is stored in pixels.
    pub width: f32,
    pub height: f32,

    // When enabled, Livewall POSTs the requested scopes as JSON to
    // forwarding_url roughly every 5 seconds.
    #[serde(default)]
    pub forwarding_enabled: bool,
    #[serde(default)]
    pub forwarding_url: String,
    #[serde(default)]
    pub forwarding_scopes: Vec<String>,
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
 * Shared, thread-safe handle to the current settings so the
 * background forwarding thread can read live overlay config
 * without going through Tauri IPC.
 */
pub struct SettingsState(pub Arc<Mutex<AppSettings>>);

#[derive(Serialize, Debug, Default, Clone)]
struct HardwareInfo {
    cpu_usage_percent: f32,
    memory_used_mb: u64,
    memory_total_mb: u64,
    // Approximate — averaged across GPU engine counters. None if
    // unavailable (non-Windows, no GPU, or the WMI query failed).
    gpu_usage_percent: Option<f32>,
}

fn load_settings_from_store(app: &AppHandle) -> AppSettings {
    let store = match app.store("settings.json") {
        Ok(store) => store,
        Err(_) => return AppSettings::default(),
    };

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
 * Reads persisted configuration from settings.json.
 */
#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    load_settings_from_store(&app)
}

/*
 * Persists new configuration to settings.json.
 */
#[tauri::command]
fn update_settings(
    app: AppHandle,
    new_settings: AppSettings,
    state: State<SettingsState>,
) -> Result<(), String> {
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
     * Keep the background forwarding thread's view of the settings
     * up to date.
     */
    if let Ok(mut guard) = state.0.lock() {
        *guard = new_settings.clone();
    }

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

fn collect_hardware_info(sys: &mut System) -> HardwareInfo {
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    HardwareInfo {
        cpu_usage_percent: sys.global_cpu_usage(),
        memory_used_mb: sys.used_memory() / 1024 / 1024,
        memory_total_mb: sys.total_memory() / 1024 / 1024,
        gpu_usage_percent: collect_gpu_usage(),
    }
}

/*
 * Approximate GPU utilization via the same performance counters
 * Task Manager's GPU graph uses. This averages across all GPU
 * engine instances, so it's a rough signal, not an exact figure.
 * Returns None (never panics) if WMI or the counter is unavailable.
 */
#[cfg(target_os = "windows")]
fn collect_gpu_usage() -> Option<f32> {
    use std::collections::HashMap;
    use wmi::{COMLibrary, Variant, WMIConnection};

    let com_con = COMLibrary::new().ok()?;
    let wmi_con = WMIConnection::new(com_con).ok()?;

    let results: Vec<HashMap<String, Variant>> = wmi_con
        .raw_query(
            "SELECT UtilizationPercentage FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine",
        )
        .ok()?;

    if results.is_empty() {
        return None;
    }

    let mut total = 0f64;
    let mut count = 0u32;

    for row in results {
        let value = match row.get("UtilizationPercentage") {
            Some(Variant::UI8(v)) => Some(*v as f64),
            Some(Variant::UI4(v)) => Some(*v as f64),
            Some(Variant::UI2(v)) => Some(*v as f64),
            _ => None,
        };

        if let Some(v) = value {
            total += v;
            count += 1;
        }
    }

    if count == 0 {
        return None;
    }

    Some((total / count as f64).min(100.0) as f32)
}

#[cfg(not(target_os = "windows"))]
fn collect_gpu_usage() -> Option<f32> {
    None
}

#[cfg(target_os = "windows")]
fn collect_window_titles() -> Vec<String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let titles = &mut *(lparam.0 as *mut Vec<String>);

        if IsWindowVisible(hwnd).as_bool() {
            let length = GetWindowTextLengthW(hwnd);

            if length > 0 {
                let mut buffer = vec![0u16; (length + 1) as usize];
                let copied = GetWindowTextW(hwnd, &mut buffer);

                if copied > 0 {
                    let title = String::from_utf16_lossy(&buffer[..copied as usize]);

                    if !title.trim().is_empty() {
                        titles.push(title);
                    }
                }
            }
        }

        BOOL(1)
    }

    let mut titles: Vec<String> = Vec::new();

    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut titles as *mut _ as isize));
    }

    titles
}

#[cfg(not(target_os = "windows"))]
fn collect_window_titles() -> Vec<String> {
    Vec::new()
}

#[derive(Serialize, Debug, Clone, Default)]
struct MediaInfo {
    title: String,
    artist: String,
    album: String,
    is_playing: bool,
    source_app: Option<String>,
    artwork: Option<String>,
}

#[cfg(target_os = "windows")]
fn read_media_artwork(
    reference: &windows::Storage::Streams::IRandomAccessStreamReference,
) -> Option<String> {
    use base64::Engine;
    use windows::Storage::Streams::DataReader;

    let stream = reference.OpenReadAsync().ok()?.get().ok()?;

    let size = stream.Size().ok()?;

    // Avoid accidentally sending huge media artwork.
    if size == 0 || size > 10 * 1024 * 1024 {
        return None;
    }

    let input = stream.GetInputStreamAt(0).ok()?;

    let reader = DataReader::CreateDataReader(&input).ok()?;

    reader
        .LoadAsync(size as u32)
        .ok()?
        .get()
        .ok()?;

    let mut buffer = vec![0u8; size as usize];

    reader.ReadBytes(&mut buffer).ok()?;

    if buffer.is_empty() {
        return None;
    }

    let mime = if buffer.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if buffer.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if buffer.starts_with(b"GIF8") {
        "image/gif"
    } else if buffer.starts_with(b"RIFF")
        && buffer.len() > 12
        && &buffer[8..12] == b"WEBP"
    {
        "image/webp"
    } else {
        "application/octet-stream"
    };

    let encoded =
        base64::engine::general_purpose::STANDARD.encode(&buffer);

    Some(format!("data:{};base64,{}", mime, encoded))
}

#[cfg(target_os = "windows")]
fn collect_media_info() -> Option<MediaInfo> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };

    let manager = SessionManager::RequestAsync().ok()?.get().ok()?;

    // Prefer Spotify, then fall back to the session currently
    // associated with media focus.
    let sessions = manager.GetSessions().ok()?;
    let mut target = None;

    for session in sessions {
        if let Ok(app_id) = session.SourceAppUserModelId() {
            if app_id.to_string().to_lowercase().contains("spotify") {
                target = Some(session);
                break;
            }
        }
    }

    let session = target.or_else(|| manager.GetCurrentSession().ok())?;

    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let playback = session.GetPlaybackInfo().ok()?;
    let status = playback.PlaybackStatus().ok()?;

    let artwork = props
        .Thumbnail()
        .ok()
        .and_then(|reference| read_media_artwork(&reference));

    Some(MediaInfo {
        title: props
            .Title()
            .map(|s| s.to_string())
            .unwrap_or_default(),

        artist: props
            .Artist()
            .map(|s| s.to_string())
            .unwrap_or_default(),

        album: props
            .AlbumTitle()
            .map(|s| s.to_string())
            .unwrap_or_default(),

        is_playing: status == PlaybackStatus::Playing,

        source_app: session
            .SourceAppUserModelId()
            .ok()
            .map(|s| s.to_string()),

        artwork,
    })
}

#[cfg(not(target_os = "windows"))]
fn collect_media_info() -> Option<MediaInfo> {
    None
}
/*
 * Background loop: every 5 seconds, checks which widgets currently
 * have forwarding enabled, gathers only the scopes actually
 * requested across them (so idle widgets cost nothing), and POSTs a
 * JSON payload to each widget's forwarding_url. Each POST runs on
 * its own short-lived thread so one slow/unreachable endpoint can't
 * delay collection or delivery for the others.
 */
fn spawn_forwarding_thread(state: Arc<Mutex<AppSettings>>) {
    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(4))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());

        let mut sys = System::new_all();

        loop {
            thread::sleep(Duration::from_secs(5));

            let overlays = match state.lock() {
                Ok(guard) => guard.overlays.clone(),
                Err(_) => continue,
            };

            let active: Vec<WallpaperOverlay> = overlays
                .into_iter()
                .filter(|o| {
                    o.forwarding_enabled
                        && !o.forwarding_url.trim().is_empty()
                        && !o.forwarding_scopes.is_empty()
                })
                .collect();

            if active.is_empty() {
                continue;
            }

            let needs_hardware = active
                .iter()
                .any(|o| o.forwarding_scopes.iter().any(|s| s == "hardware"));

            let needs_windows = active
                .iter()
                .any(|o| o.forwarding_scopes.iter().any(|s| s == "windows"));

            let needs_media = active
                .iter()
                .any(|o| o.forwarding_scopes.iter().any(|s| s == "media"));

            let media = if needs_media {
                collect_media_info()
            } else {
                None
            };

            let hardware = if needs_hardware {
                Some(collect_hardware_info(&mut sys))
            } else {
                None
            };

            let windows = if needs_windows {
                Some(collect_window_titles())
            } else {
                None
            };

            let timestamp_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);

            for overlay in active {
                let mut payload = serde_json::Map::new();

                payload.insert(
                    "widget_id".into(),
                    serde_json::Value::String(overlay.id.clone()),
                );

                payload.insert(
                    "timestamp_ms".into(),
                    serde_json::Value::from(timestamp_ms as u64),
                );

                if overlay.forwarding_scopes.iter().any(|s| s == "hardware") {
                    if let Some(hw) = &hardware {
                        if let Ok(value) = serde_json::to_value(hw) {
                            payload.insert("hardware".into(), value);
                        }
                    }
                }

                if overlay.forwarding_scopes.iter().any(|s| s == "windows") {
                    if let Some(w) = &windows {
                        if let Ok(value) = serde_json::to_value(w) {
                            payload.insert("windows".into(), value);
                        }
                    }
                }

                if overlay.forwarding_scopes.iter().any(|s| s == "media") {
                    if let Some(m) = &media {
                        if let Ok(value) = serde_json::to_value(m) {
                            payload.insert("media".into(), value);
                        }
                    }
                }

                let url = overlay.forwarding_url.clone();
                let client = client.clone();
                let body = serde_json::Value::Object(payload);

                thread::spawn(move || {
                    if let Err(error) = client.post(&url).json(&body).send() {
                        eprintln!(
                            "Livewall: failed to forward data for widget to '{}': {}",
                            url, error
                        );
                    }
                });
            }
        }
    });
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
             * Load settings once up front so the forwarding thread
             * has a real starting point (not just AppSettings::default()),
             * then keep it in sync via update_settings.
             */
            let initial_settings = load_settings_from_store(app.handle());
            let settings_state = Arc::new(Mutex::new(initial_settings));

            app.manage(SettingsState(settings_state.clone()));

            spawn_forwarding_thread(settings_state);

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
                         *
                         * On Windows, production builds are served over
                         * http://tauri.localhost (not the tauri:// scheme),
                         * because WebView2 requires an http(s) origin.
                         */
                        if scheme == "tauri" {
                            return true;
                        }

                        if (scheme == "http" || scheme == "https")
                            && url.host_str() == Some("tauri.localhost")
                        {
                            return true;
                        }

                        /*
                         * Allow the Vite development server.
                         */
                        if cfg!(dev) && scheme == "http" && url.host_str() == Some("localhost") {
                            return true;
                        }

                        /*
                         * Any other external HTTP/HTTPS navigation goes to the
                         * system browser instead of navigating the Livewall window.
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
