use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_cli::CliExt;
use betterfountain_rust as fountain;
use betterfountain_rust::docx::generate_docx_document;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use printpdf::*;
use std::sync::Mutex;
use std::path::PathBuf;
use std::net::TcpListener;
use std::io::{Read, Write};

const SINGLE_INSTANCE_PORT: u16 = 16658;

struct AppState {
    watched_file: Mutex<Option<PathBuf>>,
    stop_watcher: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn parse_fountain(text: String) -> String {
    use betterfountain_rust::{FountainParser, Conf};
    let mut parser = FountainParser::new();
    let result = parser.parse(&text, &Conf::default(), false, Some(true));
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

    // 停止旧的监听器
    if let Some(stop_sender) = state.stop_watcher.lock().unwrap().take() {
        let _ = stop_sender.send(());
    }

    *state.watched_file.lock().unwrap() = None;

    let app_handle = app.clone();
    let watch_path = file_path.clone();

    // 创建停止通道
    let (stop_tx, stop_rx) = std::sync::mpsc::channel();
    *state.stop_watcher.lock().unwrap() = Some(stop_tx);

    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_)) {
                    let _ = tx.send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(_) => return,
        };

        if watcher.watch(&watch_path, RecursiveMode::NonRecursive).is_err() {
            return;
        }

        loop {
            // 使用 select 来检查是否需要停止
            use std::sync::mpsc::TryRecvError;
            
            // 检查停止信号
            match stop_rx.try_recv() {
                Ok(_) => break,  // 收到停止信号
                Err(TryRecvError::Empty) => {},  // 继续运行
                Err(TryRecvError::Disconnected) => break,  // 通道关闭
            }
            
            // 检查文件变化（非阻塞）
            match rx.try_recv() {
                Ok(_) => {
                    let _ = app_handle.emit("file-changed", &path);
                }
                Err(TryRecvError::Empty) => {
                    // 短暂休眠避免 CPU 占用过高
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(TryRecvError::Disconnected) => break,
            }
        }
    });

    *state.watched_file.lock().unwrap() = Some(file_path);
    Ok(())
}

#[tauri::command]
fn unwatch_file(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    
    // 发送停止信号
    if let Some(stop_sender) = state.stop_watcher.lock().unwrap().take() {
        let _ = stop_sender.send(());
    }
    
    *state.watched_file.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
async fn export_docx(text: String, output_path: String) -> Result<String, String> {
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false, None);
    
    match generate_docx_document(&output_path, &conf, &parsed).await {
        Ok(_) => Ok("DOCX exported successfully".to_string()),
        Err(e) => Err(format!("Export failed: {}", e)),
    }
}

#[tauri::command]
async fn export_docx_base64(text: String) -> Result<String, String> {
    use betterfountain_rust::{FountainParser, Conf};
    use betterfountain_rust::docx::generate_docx_document;
    let mut parser = FountainParser::new();
    let parsed = parser.parse(&text, &Conf::default(), false, None);
    
    let temp_path = std::env::temp_dir().join("fountain_preview.docx");
    let temp_path_str = temp_path.to_string_lossy().to_string();
    println!("【export_docx_base64】临时文件路径: {}", temp_path_str);
    
    match generate_docx_document(&temp_path_str, &Conf::default(), &parsed).await {
        Ok(_) => {
            println!("【export_docx_base64】DOCX 生成成功，文件: {}", temp_path_str);
            let data = std::fs::read(&temp_path).map_err(|e| e.to_string())?;
            let base64_data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
            println!("【export_docx_base64】Base64 编码完成，长度: {}", base64_data.len());
            Ok(base64_data)
        }
        Err(e) => {
            println!("【export_docx_base64】生成失败: {}", e);
            Err(format!("生成失败: {}", e))
        }
    }
}

#[tauri::command]
async fn export_pdf(text: String, output_path: String) -> Result<String, String> {
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false, None);
    
    let (doc, page1, layer1) = PdfDocument::new(
        "Fountain Script",
        Mm(215.9),
        Mm(279.4),
        "Layer 1",
    );
    
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    
    let mut current_layer = doc.get_page(page1).get_layer(layer1);
    let mut y_position = 260.0;
    let line_height = 5.0;
    let margin_left = 25.0;
    
    for token in &parsed.tokens {
        let token_type = &token.token_type;
        let text_content = token.clean_text();
        
        if text_content.is_empty() {
            continue;
        }
        
        if y_position < 20.0 {
            let (new_page, new_layer) = doc.add_page(Mm(215.9), Mm(279.4), "Page");
            current_layer = doc.get_page(new_page).get_layer(new_layer);
            y_position = 260.0;
        }
        
        match token_type.as_str() {
            "scene_heading" => {
                current_layer.use_text(&text_content.to_uppercase(), 12.0, Mm(margin_left), Mm(y_position), &font_bold);
                y_position -= line_height * 2.0;
            }
            "character" => {
                current_layer.use_text(&text_content.to_uppercase(), 11.0, Mm(70.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "dialogue" => {
                current_layer.use_text(&text_content, 11.0, Mm(35.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "parenthetical" => {
                current_layer.use_text(&text_content, 10.0, Mm(40.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "action" => {
                current_layer.use_text(&text_content, 11.0, Mm(margin_left), Mm(y_position), &font);
                y_position -= line_height;
            }
            _ => {
                current_layer.use_text(&text_content, 11.0, Mm(margin_left), Mm(y_position), &font);
                y_position -= line_height;
            }
        }
    }
    
    doc.save(&mut std::io::BufWriter::new(std::fs::File::create(&output_path).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    
    Ok("PDF exported successfully".to_string())
}

#[tauri::command]
async fn export_pdf_base64(text: String) -> Result<String, String> {
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false, None);
    
    let (doc, page1, layer1) = PdfDocument::new(
        "Fountain Script",
        Mm(215.9),
        Mm(279.4),
        "Layer 1",
    );
    
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let font_bold = doc.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    
    let mut current_layer = doc.get_page(page1).get_layer(layer1);
    let mut y_position = 260.0;
    let line_height = 5.0;
    let margin_left = 25.0;
    
    for token in &parsed.tokens {
        let token_type = &token.token_type;
        let text_content = token.clean_text();
        
        if text_content.is_empty() {
            continue;
        }
        
        if y_position < 20.0 {
            let (new_page, new_layer) = doc.add_page(Mm(215.9), Mm(279.4), "Page");
            current_layer = doc.get_page(new_page).get_layer(new_layer);
            y_position = 260.0;
        }
        
        match token_type.as_str() {
            "scene_heading" => {
                current_layer.use_text(&text_content.to_uppercase(), 12.0, Mm(margin_left), Mm(y_position), &font_bold);
                y_position -= line_height * 2.0;
            }
            "character" => {
                current_layer.use_text(&text_content.to_uppercase(), 11.0, Mm(70.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "dialogue" => {
                current_layer.use_text(&text_content, 11.0, Mm(35.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "parenthetical" => {
                current_layer.use_text(&text_content, 10.0, Mm(40.0), Mm(y_position), &font);
                y_position -= line_height;
            }
            "action" => {
                current_layer.use_text(&text_content, 11.0, Mm(margin_left), Mm(y_position), &font);
                y_position -= line_height;
            }
            _ => {
                current_layer.use_text(&text_content, 11.0, Mm(margin_left), Mm(y_position), &font);
                y_position -= line_height;
            }
        }
    }
    
    let buffer = doc.save_to_bytes().map_err(|e| e.to_string())?;
    
    use base64::Engine;
    let base64_str = base64::engine::general_purpose::STANDARD.encode(&buffer);
    
    Ok(format!("data:application/pdf;base64,{}", base64_str))
}

#[tauri::command]
async fn open_in_editor(app: tauri::AppHandle, file_path: String, line: u32, editor: Option<String>, template: Option<String>) -> Result<String, String> {
    let line = line + 1; // 转换为 1-based 行号
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

    if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)) {
        let payload = cli_args.join(" ");
        let _ = stream.write_all(payload.as_bytes());
        println!("Forwarded CLI args to running instance, exiting.");
        return;
    }

    tauri::Builder::default()
        .manage(AppState {
            watched_file: Mutex::new(None),
            stop_watcher: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![greet, parse_fountain, read_file, export_docx, export_docx_base64, export_pdf, export_pdf_base64, watch_file, unwatch_file, open_in_editor])
        .setup(|app| {
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