# Desktop packaging

This is the first Apple Silicon macOS packaging proof. It preserves the Bun/React/SQLite/Python/Ollama architecture. GitHub Releases, a Homebrew cask, notarization, automatic updates and model onboarding are subsequent work.

## Build and artifacts

Run `bun run build:desktop` on Apple Silicon macOS with Rust/Cargo, Xcode Command Line Tools, Bun and uv available. `bun run build:desktop --app-only` omits DMG creation. The minimum macOS version is 15, matching the bundled orjson extension's declared native minimum. A clean installation test on macOS 15 remains required. Intel builds are not provided.

The build retains `bun.lock`, `scraper/uv.lock` and `src-tauri/Cargo.lock`. PyInstaller is in the optional uv `packaging` dependency group. The build uses a relocatable directory bundle, collects dynamically loaded scraper packages and data, and installs Chromium through the pinned Patchright version. No models, user library, backups, credentials or development venv are bundled.

Generated files live in `.desktop-build/` and `src-tauri/resources/`. The installed layout is:

```text
Braindump.app/Contents/
  MacOS/braindump-desktop
  Resources/
    web/                          Built React UI
    runtime/braindump-server       Compiled Bun server and SQLite
    runtime/scraper/               Frozen Python and native dependencies
    runtime/browsers/              Pinned Chromium and helpers
    LICENSE
```

The build signs Mach-O files and nested frameworks/apps before the outer app, then runs `codesign --verify --deep --strict`. The default identity is ad-hoc (`-`). `BRAINDUMP_SIGN_IDENTITY` can select an installed Developer ID identity; this does not perform notarization. The test artifact is not ready for unrestricted public distribution. A public release also needs a redistribution-notice inventory for bundled dependencies, appropriate signing entitlements verified under hardened runtime, notarization/stapling, and Gatekeeper installation tests.

Source references: [Tauri sidecars](https://v2.tauri.app/develop/sidecar/), [Bun standalone executables](https://bun.sh/docs/bundler/executables), [PyInstaller](https://pyinstaller.org/en/stable/usage.html), [macOS signing](https://v2.tauri.app/distribute/sign/macos/).

## Data and lifecycle

Desktop defaults are `~/Library/Application Support/Braindump/` for the library, `~/Library/Logs/Braindump/` for logs and `~/Library/Caches/Braindump/` for caches. `DATA_DIR`, `BRAINDUMP_LOG_DIR` and `BRAINDUMP_CACHE_DIR` permit isolated testing. The native wrapper supplies `BRAINDUMP_RESOURCES` and the session token. The app must never write into its signed resources. Source mode retains the repository data directory and existing browser API.

The default loopback port is 3210; `PORT` can override it. A conflicting server produces a startup error. The desktop API requires an app-only session, so the existing terminal importer should continue to target source mode; use the desktop UI for imports in this proof. Changing ports also changes the webview origin used for appearance/layout preferences.

Closing the main window hides it while processing continues. The menu-bar icon reopens it or quits the app. A second desktop launch focuses the existing instance. Quit sends shutdown to the owned backend; closing its parent pipe also initiates shutdown. The backend cancels only its own work, preserves interrupted jobs and closes the database before releasing its kernel library lock. The wrapper applies a bounded fallback to its own backend process group if graceful shutdown fails. Errors appear in the startup window and local backend log; large logs rotate at next launch.

Migration uses the existing validated JSON restore workflow. Export from the source app, stop that server, open the desktop app, and select the backup in Settings & Backups. Review the replacement confirmation and configure the backup directory separately. Source data remains untouched. Job history/priorities and unfinished analysis checkpoints are intentionally absent from JSON backups.

## Verification

Run `bun run verify` for the shared code, offline regressions and production build. Desktop sources additionally require `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and macOS Clippy/build checks with the generated resources present. The local build target and Cargo cache are under `.desktop-build/` by default.

`bun run test:desktop` relocates the app to a temporary path containing spaces, checks all signatures, runs the compiled SQLite/FTS diagnostic, starts the backend with a minimal PATH and temporary writable folders, and verifies private-session boundaries, API writes, backup/restore and parent-death shutdown. The native shell itself still needs manual inspection for startup, menus, close/reopen, quit and crash reporting.

`bun run test:desktop:live` additionally exercises real HTML, text-layer PDF and forced Chromium extraction, then waits for the installed worker to complete an Ollama summary. It uses the configured local model, does not stop or unload Ollama, and removes its temporary library afterward. Website availability and model contention can affect this check; queued work alone is not a pass.

Before public distribution, test the actual DMG on a clean Mac without developer tools, test the oldest declared macOS version, measure installation/update behavior, and verify hardened-runtime signing plus notarization. A relocated app with a minimal PATH is useful evidence but does not establish those checks.
