# Contributing to Livewall

Thanks for your interest in contributing to Livewall! Contributions of all kinds are welcome, including bug fixes, features, performance improvements, UI improvements, documentation, and new ideas.

## Getting Started

### Requirements

You'll need:

* Windows 10 or 11
* Node.js and npm
* Rust and Cargo
* Tauri 2 prerequisites
* WebView2

Clone the repository and install dependencies:

```bash
git clone https://github.com/emjjkk/livewall.git
cd livewall
npm install
```

Start the development application:

```bash
npm run tauri dev
```

## Project Structure

Livewall is split between a React frontend and a Rust backend.

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

Use `src/` for frontend functionality and UI.

Use `src-tauri/src/` for native Windows functionality, Tauri commands, persistence, system integrations, tray behavior, and data collection.

## Development Commands

```bash
npm run tauri dev       # Start the development application
npm run tauri build     # Build the production application
npm run build           # Build the frontend
npm run format          # Format the project with Biome
npm run format:check    # Check formatting
npm run lint            # Run linting
npm run check           # Run Biome checks
```

Before opening a pull request, make sure the relevant checks pass.

## Adding Tauri Commands

When adding a new Tauri command:

1. Implement the command in `src-tauri/src/lib.rs`.
2. Register it in `tauri::generate_handler!`.
3. Add any required permissions to `src-tauri/capabilities/default.json`.
4. Call the command from React using `invoke()`.

Keep native operations native whenever possible. Large files and file contents should not unnecessarily pass through the WebView.

## Making Changes

Try to keep changes focused and easy to review.

For example:

* Fix a bug in a dedicated pull request.
* Avoid unrelated refactors in feature pull requests.
* Update documentation when changing user-facing behavior.
* Reuse existing components and patterns where practical.
* Prefer simple solutions over unnecessary abstractions.

For UI changes, test the affected settings and wallpaper/widget flows rather than only checking that the application compiles.

For native functionality, test the behavior on Windows whenever possible.

## Widgets and Data Forwarding

If you're modifying widget behavior or data forwarding, keep the existing `widget_id` model in mind.

`widget_id` is a random UUID used to identify a widget's data bucket. It is **not an authentication token** and must not be treated as one.

Changes involving forwarded data should also consider:

* `hardware`
* `media`
* `windows`
* forwarding intervals
* request timeouts
* failed endpoint requests
* sensitive window-title data

Avoid introducing behavior that sends system information somewhere without the user's explicit configuration.

## Pull Requests

Before submitting a pull request:

1. Make sure your branch contains only the changes relevant to the pull request.
2. Run the appropriate formatting, linting, and build checks.
3. Test the affected functionality.
4. Update documentation if necessary.
5. Write a clear pull request description explaining what changed and why.

A useful pull request description should generally include:

```text
## What changed?

Brief description of the change.

## Why?

Explain the problem or motivation.

## Testing

Explain how the change was tested.
```

Screenshots or short recordings are especially useful for UI changes.

## Bug Reports

When reporting a bug, include as much of the following as possible:

* Windows version
* Livewall version or commit
* Steps to reproduce
* Expected behavior
* Actual behavior
* Relevant logs or error messages
* Screenshots or recordings when useful
* Wallpaper/widget configuration involved

A minimal reproduction is always appreciated.

## Feature Requests

Feature requests are welcome.

Before proposing a large feature, consider whether it fits Livewall's core goals of being **minimal, lightweight, and practical**.

For larger architectural changes, opening an issue before implementation is recommended. This gives us a chance to discuss the approach and avoid unnecessary work.

## Code Style

Follow the existing project conventions.

In particular:

* Use TypeScript for frontend code.
* Use Rust for native functionality.
* Keep components reasonably small.
* Prefer clear names over clever abstractions.
* Keep types explicit where they improve readability.
* Format code with Biome.
* Avoid introducing dependencies for functionality that can reasonably be implemented with the existing stack.

## Commit Messages

There is no strict commit-message format, but commits should be descriptive.

Prefer:

```text
Add widget forwarding timeout
Fix wallpaper pause detection
Improve widget positioning
Update development documentation
```

Over:

```text
fix
changes
stuff
updated
```

## Security

Please do not report security vulnerabilities through public GitHub issues.

If you discover a security issue involving Livewall, contact the project maintainer privately with enough information to reproduce and understand the issue.

In particular, avoid publicly exposing:

* Private endpoint credentials
* Authentication tokens
* Sensitive system data
* Private widget URLs
* Other users' data

Remember that forwarded window titles can contain sensitive information.

## License

By contributing to Livewall, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).

Thanks for helping make Livewall better ❤️
