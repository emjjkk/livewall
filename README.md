<img width="80" height="80" alt="icon" src="https://github.com/user-attachments/assets/867e1331-de28-4a1e-88c5-97f384ca1f70" />

# Livewall

**A lightweight live wallpaper and desktop widget engine for Windows 10/11.**

Livewall runs as a tray application and lets you use an **image, video, or webpage as your desktop wallpaper**. You can also place arbitrary URLs on top of the wallpaper as interactive, resizable widgets.

> Right-click the tray icon to open Settings.

### Table of Contents

* [Features](#features)
* [Wallpapers](#wallpapers)
* [Widgets](#widgets)

  * [`widget_id`](#widget_id)
  * [Data forwarding](#data-forwarding)
  * [Building a widget](#building-a-widget)
* [Interactivity and navigation](#interactivity-and-navigation)
* [Pause behavior](#pause-behavior)
* [Settings](#settings)
* [Architecture](#architecture)
* [Development](#development)
* [Contributing](#contributing)
* [Known issues](#known-issues)
* [License](#license)


## Features

* Image, video, and webpage wallpapers
* Arbitrary webpage widgets
* Interactive widgets with mouse and keyboard input
* Custom widget positioning and sizing
* Optional PC data forwarding to widget backends
* Windows media session integration
* CPU, RAM, GPU, and window information
* Pause on battery
* Pause when unfocused or occluded
* Windows autostart
* Lightweight Tauri + Rust architecture

## Wallpapers

Livewall supports three wallpaper types:

| Type      | Source                         | Behavior                               |
| --------- | ------------------------------ | -------------------------------------- |
| `image`   | Local file or direct image URL | Full-screen `<img>`                    |
| `video`   | Local file or direct video URL | Looping, autoplaying `<video>`         |
| `webpage` | Any URL                        | Full-screen non-interactive `<iframe>` |

Local wallpaper files are copied directly from disk into Livewall's app-data directory by Rust, avoiding unnecessary transfer through the WebView.

URLs are detected automatically by extension. Anything that isn't recognized as an image or video is treated as a webpage.

Webpage wallpapers intentionally don't receive pointer input, so clicking the desktop doesn't accidentally interact with the wallpaper.

## Widgets

A widget is a URL rendered as an interactive `<iframe>` above the wallpaper.

Add one through **Settings → Widgets → Add**, then configure its position and size.

Widgets support:

* Links and navigation
* Scrolling and forms
* JavaScript
* Mouse and keyboard input
* Custom query parameters

#### Positioning

Widgets use percentage-based center anchors:

```text
x:      0 ───────── 50 ───────── 100%
        left        center        right

y:      0 ───────── 50 ───────── 100%
        top         center        bottom
```

`width` and `height` are specified in pixels.

For example:

```text
x: 0
y: 100
```

anchors the widget to the bottom-left corner.

Internally, Livewall uses `translate()` to keep widgets inside the selected edge:

```css
left: {x}%;
top: {y}%;
transform: translate(
  {x === 0 ? "0%" : x === 100 ? "-100%" : "-50%"},
  {y === 0 ? "0%" : y === 100 ? "-100%" : "-50%"}
);
```

## `widget_id`

Every widget receives a unique UUID when it is added:

```ts
const overlay = {
  id: crypto.randomUUID(),
  url,
};
```

This ID is stored with the widget's local settings and is automatically added to its URL:

```text
https://example.com/widget?widget_id=3fa8...
```

You **do not need to add `widget_id` yourself**. Livewall overwrites any existing value.

The same ID is also included in every forwarded payload:

```json
{
  "widget_id": "3fa8...",
  "timestamp_ms": 1735689600000
}
```

This allows a single hosted widget to serve many Livewall users without requiring accounts or API keys.

```text
User A                         User B

widget_id = aaa-111            widget_id = bbb-222
       │                               │
       ├── /widget?widget_id=aaa       ├── /widget?widget_id=bbb
       │                               │
       └── POST { widget_id: aaa }     └── POST { widget_id: bbb }
                    │
                    ▼
             Your backend/storage
             keyed by widget_id
```

#### Important properties

* `widget_id` is a random UUID, not an authentication token.
* It isn't tied to a user, machine, or account.
* Removing and re-adding a widget creates a new ID.
* Adding the same widget URL twice creates two different IDs.
* Widgets that don't need forwarded data can ignore the ID completely.

Treat knowledge of a `widget_id` as access to that widget's data bucket, **not authentication**.

## Data forwarding

Widgets can optionally receive live information from the host computer.

Enable it in the widget's settings by providing a `forwarding_url` and selecting one or more scopes:

* `hardware`
* `media`
* `windows`

Livewall collects forwarding data roughly every **5 seconds**.

Scopes requested by multiple widgets are collected once per tick and reused across their payloads. Each widget then receives its own POST request containing its own `widget_id`.

Requests have a **4-second timeout** and run independently, so a slow endpoint won't block other widgets. Failed requests are logged and dropped without retries.

#### Payload

Every payload contains:

```json
{
  "widget_id": "3fa8...",
  "timestamp_ms": 1735689600000
}
```

Requested scopes are added as top-level fields.

#### `hardware`

Provides approximate system resource usage:

```json
{
  "hardware": {
    "cpu_usage_percent": 12.4,
    "memory_used_mb": 8213,
    "memory_total_mb": 16384,
    "gpu_usage_percent": 6.1
  }
}
```

CPU and memory are collected using `sysinfo`. GPU usage is a Windows-only approximation based on the same performance counters used by Task Manager.

`gpu_usage_percent` may be `null` when unavailable.

#### `media`

Uses Windows System Media Transport Controls:

```json
{
  "media": {
    "title": "Song Name",
    "artist": "Artist Name",
    "album": "Album Name",
    "is_playing": true,
    "source_app": "Spotify.exe",
    "artwork": "data:image/jpeg;base64,..."
  }
}
```

Spotify is preferred when multiple media sessions are available.

Artwork is returned as a base64 data URI and capped at 10 MB.

#### `windows`

Returns titles of currently visible top-level windows:

```json
{
  "windows": [
    "Inbox — Outlook",
    "main.rs — my-project — Cursor",
    "Twitch"
  ]
}
```

**Window titles may contain sensitive information**, including document names, email subjects, or page titles. Only forward this scope to an endpoint you control or trust.

#### Forwarding security

Livewall does not authenticate or validate forwarding endpoints. Data is sent exactly as configured.

Widget backends should:

* Validate incoming payloads
* Never treat `widget_id` as authentication
* Rate-limit if necessary
* Use HTTPS

## Building a widget

A Livewall widget is simply a webpage. No SDK or special runtime is required.

There are two basic types.

#### Static widget

If your widget doesn't need PC data, simply host a webpage and add its URL to Livewall.

Examples include:

* Clocks
* Animations
* Static embeds
* Dashboards with their own APIs

`widget_id` can safely be ignored.

#### Data-powered widget

If your widget needs forwarded data, the typical architecture is:

```text
Livewall
   │
   │ POST
   ▼
/listener
   │
   │ store by widget_id
   ▼
Database / KV
   ▲
   │ GET
/api/state?widget_id=...
   ▲
   │ poll
/widget?widget_id=...
```

Typical routes:

```text
GET  /widget?widget_id=...
POST /listener
GET  /api/state?widget_id=...
```

The widget page reads its `widget_id` from the URL and periodically requests its state.

A basic implementation flow:

1. Choose the scopes you need.
2. Create a `/listener` endpoint.
3. Validate the `widget_id`.
4. Store data keyed by `widget_id`.
5. Create a state endpoint.
6. Read `widget_id` from the widget URL.
7. Poll your state endpoint and render the latest data.
8. Deploy over HTTPS.
9. Add the widget URL and forwarding endpoint to Livewall.

Livewall only manages the `widget_id` query parameter. Any other query parameters are yours to define and are preserved.

For example:

```text
/widget?layout=compact&color=blue
```

Livewall will add its own `widget_id` without removing your parameters.

[emjjkk/livewall-spotify-now-playing](https://livewall-spotify-now-playing.vercel.app/) is a complete example using the `media` scope.


## Interactivity and navigation

Wallpaper webpages and widgets are intentionally sandboxed differently.

|                         | Wallpaper | Widget  |
| ----------------------- | --------- | ------- |
| Pointer input           | Disabled  | Enabled |
| Forms                   | Yes       | Yes     |
| Scripts                 | Yes       | Yes     |
| Popups                  | Limited   | Allowed |
| Native input forwarding | No        | Yes     |

Widget mouse and keyboard events are forwarded through `tauri-plugin-wallpaper`.

Navigation is guarded so that links and `window.open()` don't navigate the wallpaper window itself. They are opened using the system's default browser instead.

Normal links and `window.open()` therefore work without widget-specific code.

## Pause behavior

Livewall can pause when:

* The desktop is covered by a fullscreen application.
* **Pause on battery** is enabled and the system is on battery.
* **Pause when unfocused** is enabled and the desktop isn't the native foreground window.

Fullscreen occlusion is always monitored because it provides the main performance optimization.

When the state changes, Livewall sends:

#### Widgets

```js
window.postMessage({
  type: "SET_PAUSED",
  isPaused: true
});
```

#### Wallpaper webpage

```js
window.postMessage({
  type: "SET_AUDIO",
  volume: 1,
  isPaused: true
});
```

Widgets are **not unloaded or frozen** when paused. They continue running unless they choose to respond to `SET_PAUSED`.

For example:

```js
window.addEventListener("message", (event) => {
  if (event.data?.type === "SET_PAUSED") {
    // Pause polling/animations when appropriate
  }
});
```

## Settings

The persisted settings roughly follow:

```ts
interface AppSettings {
  wallpaper_type: "image" | "video" | "webpage";
  wallpaper_src: string;

  autostart: boolean;
  pause_on_battery: boolean;
  pause_on_unfocus: boolean;

  volume: number;
  is_muted: boolean;

  overlays: WallpaperOverlay[];
}

interface WallpaperOverlay {
  id: string;
  url: string;

  x: number;
  y: number;
  width: number;
  height: number;

  forwarding_enabled: boolean;
  forwarding_url: string;
  forwarding_scopes: (
    | "hardware"
    | "windows"
    | "media"
  )[];
}
```

Settings changes are persisted by Rust and broadcast to all application windows through the `settings-changed` event.

## Architecture

Livewall uses **Tauri 2 + React + TypeScript + Rust**.

```text
src/
├── components/       # React components
├── hooks/            # React hooks
├── types/            # Shared TypeScript types
├── windows/          # Wallpaper/settings UI
├── App.tsx
└── main.tsx

src-tauri/
├── src/
│   ├── lib.rs        # Commands, tray, forwarding
│   └── main.rs
├── capabilities/
├── icons/
├── Cargo.toml
└── tauri.conf.json
```

#### React handles

* Settings UI
* Wallpaper rendering
* Video/audio playback
* Widget iframes
* Local UI state

#### Rust handles

* Persistent settings
* Native file operations
* Windows battery/focus detection
* Autostart
* System tray
* Wallpaper integration
* Data forwarding
* Media, hardware, and window collection

The wallpaper window is attached to the Windows desktop through `tauri-plugin-wallpaper`. Widgets live as iframes inside this same window rather than separate native windows, keeping the application lightweight.

## Development

#### Requirements

* Node.js + npm
* Rust + Cargo
* Tauri 2 prerequisites
* WebView2 on Windows

#### Setup

```bash
git clone https://github.com/emjjkk/livewall.git
cd livewall
npm install
npm run tauri dev
```

Vite runs on:

```text
http://localhost:1420
```

#### Commands

```bash
npm run tauri dev       # Development
npm run tauri build     # Production build
npm run build           # TypeScript + Vite build
npm run format          # Format with Biome
npm run format:check    # Check formatting
npm run lint            # Lint
npm run check           # Biome check
```

For frontend work, use `src/`.

For native Windows behavior, Tauri commands, plugins, tray functionality, persistence, and wallpaper integration, use `src-tauri/src/lib.rs`.

When adding a Tauri command:

1. Implement it in `src-tauri/src/lib.rs`.
2. Add it to `tauri::generate_handler!`.
3. Add required permissions to `src-tauri/capabilities/default.json`.
4. Call it from React using `invoke()`.

Large file operations should remain native whenever possible rather than passing file bytes through the WebView.

## Known issues

* Saving large video wallpapers may briefly make the application unresponsive.
* Pause-on-unfocus can occasionally trigger when Livewall isn't actually unfocused.

#### Approximate resource usage

With a 15-second MP4 wallpaper:

```text
RAM:  ~50–150 MB
CPU:  ~0.5–3%
```

Measured approximately on an Intel Core i3 system; actual usage varies with wallpaper, resolution, widgets, and hardware.

## Contributing

Contributions are welcome! Bug fixes, features, performance improvements, UI changes, documentation, and other improvements are all appreciated.

Before submitting a pull request:

1. Fork the repository and create a branch for your change.
2. Make your changes in the appropriate `src/` or `src-tauri/` area.
3. Run the relevant checks:

   ```bash
   npm run build
   npm run format:check
   npm run lint
   npm run check
   ```
4. Test the application with `npm run tauri dev` on Windows.
5. Keep pull requests focused and update the documentation when changing user-facing behavior.

For larger features or architectural changes, opening an issue first is recommended so the approach can be discussed before implementation.

When reporting a bug, include the Windows version, Livewall version or commit, reproduction steps, and any relevant logs or screenshots.

## License

MIT
