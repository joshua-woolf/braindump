#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::{fs::DirBuilderExt, process::CommandExt},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[derive(Default)]
struct Runtime {
    child: Mutex<Option<Child>>,
    ready: AtomicBool,
    port: AtomicU16,
    quitting: AtomicBool,
    stopped: AtomicBool,
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn failure(app: &tauri::AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let mut url = tauri::Url::parse("tauri://localhost/index.html").expect("constant URL");
        url.query_pairs_mut().append_pair("error", message);
        let _ = window.navigate(url);
        let _ = window.set_title("Braindump — Startup Failed");
    }
    show(app);
}

fn stop_backend(runtime: &Runtime) {
    let child = runtime.child.lock().expect("runtime mutex").take();
    if let Some(mut child) = child {
        if let Some(mut input) = child.stdin.take() {
            let _ = writeln!(input, "shutdown");
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                _ if Instant::now() >= deadline => {
                    // Only the process group created for this backend is targeted.
                    unsafe {
                        libc::kill(-(child.id() as i32), libc::SIGKILL);
                    }
                    let _ = child.wait();
                    break;
                }
                _ => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

fn launch(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let home = app.path().home_dir()?;
    let resources = app.path().resource_dir()?;
    let logs = std::env::var_os("BRAINDUMP_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("Library/Logs/Braindump"));
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&logs)?;
    let log_path = logs.join("backend.log");
    if fs::metadata(&log_path)
        .map(|m| m.len() > 1_048_576)
        .unwrap_or(false)
    {
        fs::rename(&log_path, logs.join("backend.previous.log"))?;
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut command = Command::new(resources.join("runtime/braindump-server"));
    command.env_clear().env("PATH", "/usr/bin:/bin");
    for name in [
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "DATA_DIR",
        "PORT",
        "OLLAMA_URL",
        "OLLAMA_MODEL",
        "OLLAMA_CONTEXT",
        "TAG_REVIEW_HOURS",
        "BACKUP_HOURS",
        "BRAINDUMP_LOG_DIR",
        "BRAINDUMP_CACHE_DIR",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command
        .env("BRAINDUMP_DESKTOP", "1")
        .env("BRAINDUMP_RESOURCES", &resources)
        .env("BRAINDUMP_TOKEN", &token)
        .current_dir(&resources)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log.try_clone()?))
        .process_group(0)
        .spawn()?;
    let stdout = child.stdout.take().ok_or("Backend output is unavailable")?;
    *app.state::<Runtime>().child.lock().expect("runtime mutex") = Some(child);
    let handle = app.clone();
    thread::spawn(move || {
        let mut log = log;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                if value["type"] == "ready" {
                    if let Some(base) = value["url"].as_str() {
                        if let Ok(url) = tauri::Url::parse(&format!("{base}/__desktop/{token}")) {
                            if url.scheme() == "http" && url.host_str() == Some("127.0.0.1") {
                                handle.state::<Runtime>().port.store(
                                    url.port_or_known_default().unwrap_or(0),
                                    Ordering::SeqCst,
                                );
                                handle
                                    .state::<Runtime>()
                                    .ready
                                    .store(true, Ordering::SeqCst);
                                if let Some(window) = handle.get_webview_window("main") {
                                    let _ = window.navigate(url);
                                }
                                continue;
                            }
                        }
                    }
                }
            }
            let _ = writeln!(log, "{line}");
        }
        if !handle.state::<Runtime>().quitting.load(Ordering::SeqCst) {
            failure(&handle, "The library process stopped. Quit and reopen Braindump. Check backend.log in the app's log folder for details; another app may already own the library or port 3210.");
        }
    });
    let handle = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(15));
        let runtime = handle.state::<Runtime>();
        if !runtime.ready.load(Ordering::SeqCst) && !runtime.quitting.load(Ordering::SeqCst) {
            failure(&handle, "Braindump did not finish starting. Check the app's backend.log, then quit and reopen it.");
            stop_backend(&runtime);
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Runtime::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .setup(|app| {
            let navigation_app = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Braindump")
                .inner_size(1280.0, 860.0)
                .min_inner_size(680.0, 480.0)
                .on_navigation(move |url| {
                    if (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port_or_known_default()
                                == Some(
                                    navigation_app
                                        .state::<Runtime>()
                                        .port
                                        .load(Ordering::SeqCst),
                                ))
                    {
                        return true;
                    }
                    if ["https", "http"].contains(&url.scheme()) {
                        let destination = url.to_string();
                        thread::spawn(move || {
                            let _ = Command::new("/usr/bin/open").arg(destination).status();
                        });
                    }
                    false
                })
                .build()?;
            let open = MenuItem::with_id(app, "open", "Open Braindump", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Braindump", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("Missing app icon")?.clone())
                .tooltip("Braindump")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            if let Err(error) = launch(app.handle()) {
                failure(
                    app.handle(),
                    &format!("Could not start the library: {error}"),
                );
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize Braindump");
    app.run(|app, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let runtime = app.state::<Runtime>();
            if !runtime.stopped.load(Ordering::SeqCst) {
                api.prevent_exit();
            }
            if !runtime.quitting.swap(true, Ordering::SeqCst) {
                let handle = app.clone();
                thread::spawn(move || {
                    stop_backend(&handle.state::<Runtime>());
                    handle
                        .state::<Runtime>()
                        .stopped
                        .store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
        }
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
