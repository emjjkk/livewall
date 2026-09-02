
<img width="80" height="80" alt="icon" src="https://github.com/user-attachments/assets/867e1331-de28-4a1e-88c5-97f384ca1f70" />

# Livewall: Minimal live wallpaper and desktop widget engine for Windows 10/11

The aim of Livewall is to provide the functionality for live wallpapers and desktop widgets while incurring as little resource usage (RAM, CPU) as possible. It runs in the background as a tray application and allows you to set files (.mp4, .mov, .gif, or any image file) or URLs as your wallpaper, and any URL as a desktop widget.

> to open the settings menu, right click on the tray icon in your taskbar

### Known issues

- Uploading a video live wallpaper (.mp4 or .mov) may cause momentary unresponsiveness during the saving process
- Pause on unfocus sometimes pauses the live wallpaper even when it isn't unfocused.

### Approximate resource usage (15s MP4 wallpaper)

- RAM: ~50–150 MB
- CPU: ~0.5–3% (Intel Core i3)



## Resources



<details>
<summary>Wallpapers</summary>
 
- [https://earth-is-beautiful.vercel.app](https://earth-is-beautiful.vercel.app/) - An image of a random place in the world each time you start your computer, powered by WikiCommons



</details>


<details>
<summary>Widgets</summary>

- [Live clock](https://github.com/emjjkk/clock) (e.g. `https://clock-overlay.vercel.app/?type=digital&format=12h&show_date=true`) - Live clock and weather on your desktop
- Spotify embeds (e.g. `https://open.spotify.com/embed/track/0ZeGfEAL5Rl4pd5LZBGuEK?utm_source=generator&si=87a8634c09ee4df4`) - Embed a track or playlist on your desktop

</details>



## Development

### Prerequisites

Install:

* Node.js and npm
* Rust and Cargo
* Tauri 2 prerequisites for your platform
* On Windows, WebView2 is required

### Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/emjjkk/livewall.git
cd livewall
npm install
```

Start the Tauri development build:

```bash
npm run tauri dev
```

Vite runs on `http://localhost:1420` during development.

### Project Structure

```text
src/
├── components/       # Reusable React UI components
├── hooks/            # React hooks, including settings state
├── types/            # Shared TypeScript types
├── windows/          # Wallpaper and settings window UI
├── App.tsx           # Selects the active window
└── main.tsx          # React entry point

src-tauri/
├── src/
│   ├── lib.rs        # Tauri commands, plugins and desktop logic
│   └── main.rs       # Native application entry point
├── capabilities/     # Tauri permissions
├── icons/             # Application icons
├── Cargo.toml        # Rust dependencies
└── tauri.conf.json   # Tauri configuration
```

### Architecture

Livewall is a Tauri application with a React frontend and Rust backend.

The React side handles:

* Settings UI
* Wallpaper rendering
* Video/audio playback
* URL-based wallpaper and widget iframes
* Local UI state

The Rust side handles:

* Persistent settings through `tauri-plugin-store`
* Native file copying
* Windows battery detection
* Autostart
* System tray
* Desktop wallpaper attachment
* Tauri window management

React and Rust communicate through Tauri commands:

```text
React
  │
  ├── invoke("get_settings")
  ├── invoke("update_settings")
  ├── invoke("save_wallpaper_file")
  └── invoke("check_is_on_battery")
       │
       ▼
     Rust
```

Settings changes are persisted by Rust and broadcast back to all windows through the `settings-changed` event.

### Wallpaper Rendering

The main window is attached to the Windows desktop wallpaper layer using `tauri-plugin-wallpaper`.

The wallpaper itself is rendered as one of:

* `<img>` for images
* `<video>` for videos
* `<iframe>` for webpages

Widgets are also rendered as iframes inside the same wallpaper window. They are not separate native windows.

Local wallpapers are copied to:

```text
%APPDATA%/com.os.livewall/wallpapers/
```

Only the file path crosses the Tauri IPC boundary. Large image/video files are copied directly by Rust so their contents do not pass through the WebView.

### Useful Commands

```bash
# Development
npm run tauri dev

# Production build
npm run tauri build

# TypeScript + Vite build
npm run build

# Format
npm run format

# Check formatting
npm run format:check

# Lint
npm run lint

# Run Biome checks and apply fixes
npm run check
```

### Making Changes

For frontend changes, most work belongs under `src/`.

For native Windows behavior, Tauri commands, plugins, tray behavior, persistence, or wallpaper integration, use `src-tauri/src/lib.rs`.

When adding a new Tauri command, remember to:

1. Implement the command in `src-tauri/src/lib.rs`.
2. Add it to `tauri::generate_handler!`.
3. Add any required permissions to `src-tauri/capabilities/default.json`.
4. Call it from React using `invoke()`.

Keep large files out of the WebView/JavaScript process whenever possible. Native filesystem operations should generally be handled by Rust.

## License

Livewall is licensed under the MIT License.
