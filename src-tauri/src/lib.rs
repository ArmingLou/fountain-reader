use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_cli::CliExt;
use betterfountain_rust as fountain;
use betterfountain_rust::docx::generate_docx_document;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::sync::Mutex;
use std::path::PathBuf;
use std::net::TcpListener;
use std::io::{Read, Write};

const SINGLE_INSTANCE_PORT: u16 = 16658;

struct AppState {
    watched_file: Mutex<Option<PathBuf>>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn parse_fountain(text: String) -> String {
    let config = fountain::Conf::default();
    let result = fountain::parse(&text, &config, false);
    serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string())
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn watch_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let file_path = PathBuf::from(&path);

    *state.watched_file.lock().unwrap() = None;

    let app_handle = app.clone();
    let watch_path = file_path.clone();

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_)) {
                    let _ = tx.send(());
                }
            }
        }).unwrap();

        watcher.watch(&watch_path, RecursiveMode::NonRecursive).unwrap();

        loop {
            if rx.recv().is_err() {
                break;
            }
            let _ = app_handle.emit("file-changed", &path);
        }
    });

    *state.watched_file.lock().unwrap() = Some(file_path);
    Ok(())
}

#[tauri::command]
fn unwatch_file(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    *state.watched_file.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn export_docx(text: String, output_path: String) -> Result<String, String> {
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false);
    
    match generate_docx_document(&output_path, &conf, &parsed).await {
        Ok(_) => Ok("DOCX exported successfully".to_string()),
        Err(e) => Err(format!("Export failed: {}", e)),
    }
}

#[tauri::command]
async fn export_docx_base64(text: String) -> Result<String, String> {
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false);
    
    match generate_docx_document("$PREVIEW$", &conf, &parsed).await {
        Ok(_) => Ok("Base64 generated".to_string()),
        Err(e) => Err(format!("Generation failed: {}", e)),
    }
}

#[tauri::command]
async fn open_in_editor(app: tauri::AppHandle, file_path: String, line: u32, editor: Option<String>, template: Option<String>) -> Result<String, String> {
    let cmd = if let Some(tmpl) = template.filter(|t| !t.is_empty()) {
        tmpl.replace("{file}", &file_path).replace("{line}", &line.to_string())
    } else {
        let name = editor.unwrap_or_else(|| "zed".to_string());
        match name.as_str() {
            "zed" | "zedit" => format!("zed --add {}:{}", file_path, line),
            "code" | "vscode" => format!("code --goto {}:{}", file_path, line),
            "subl" | "sublime" => format!("subl {}:{}", file_path, line),
            "atom" => format!("atom {}:{}", file_path, line),
            _ => format!("{} {}:{}", name, file_path, line),
        }
    };

    let shell = app.shell();
    let output = shell.command("sh").args(["-c", &cmd]).output().await
        .map_err(|e| format!("Failed to launch editor: {}", e))?;

    if output.status.success() {
        Ok("Editor opened".to_string())
    } else {
        Err(format!("Editor exited with error: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_args = std::env::args().collect::<Vec<_>>();

    // 检测是否已有运行实例
    if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)) {
        let payload = cli_args.join(" ");
        let _ = stream.write_all(payload.as_bytes());
        println!("Forwarded CLI args to running instance, exiting.");
        return;
    }

    tauri::Builder::default()
        .manage(AppState {
            watched_file: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![greet, parse_fountain, read_file, export_docx, export_docx_base64, watch_file, unwatch_file, open_in_editor])
        .setup(|app| {
            // 启动单实例监听器
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let listener = TcpListener::bind(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)).unwrap();
                for stream in listener.incoming() {
                    if let Ok(mut s) = stream {
                        let mut buf = String::new();
                        if s.read_to_string(&mut buf).is_ok() {
                            let editor = buf.split_whitespace()
                                .skip_while(|a| *a != "-e" && *a != "--editor")
                                .nth(1)
                                .map(|s| s.to_string());
                            if let Some(ed) = editor {
                                let _ = handle.emit("cli-editor", ed);
                            }
                        }
                    }
                }
            });

            if let Ok(cli) = app.cli().matches() {
                if let Some(editor) = cli.args.get("editor") {
                    let ed = editor.value.to_string();
                    let _ = app.handle().emit("cli-editor", ed);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
