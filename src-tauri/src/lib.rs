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
    /// 由 RunEvent::Opened (macOS 双击) 设置的文件路径，
    /// 供前端 get_cli_args 兜底查询
    opened_file: Mutex<Option<PathBuf>>,
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
    println!("[PDF生成] 开始生成，文本长度: {}", text.len());
    let conf = fountain::Conf::default();
    let mut parser = fountain::FountainParser::new();
    let parsed = parser.parse(&text, &conf, false, None);
    
    println!("[PDF生成] 解析完成，tokens数量: {}", parsed.tokens.len());
    
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
    
    let mut rendered_count = 0;
    for token in &parsed.tokens {
        let token_type = &token.token_type;
        let text_content = token.clean_text();
        
        if text_content.is_empty() {
            continue;
        }
        
        rendered_count += 1;
        
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
    
    println!("[PDF生成] 渲染了 {} 个token", rendered_count);
    
    let buffer = doc.save_to_bytes().map_err(|e| e.to_string())?;
    println!("[PDF生成] PDF字节长度: {}", buffer.len());
    
    use base64::Engine;
    let base64_str = base64::engine::general_purpose::STANDARD.encode(&buffer);
    println!("[PDF生成] Base64长度: {}", base64_str.len());
    
    Ok(format!("data:application/pdf;base64,{}", base64_str))
}

/// 校验路径是否是指定的剧本文件（以 .fountain / .spmd / .txt 结尾）
fn is_fountain_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".fountain") || lower.ends_with(".spmd") || lower.ends_with(".txt")
}

/// 去除字符串首尾的引号（单引号或双引号）
fn trim_quotes(s: &str) -> &str {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        &s[1..s.len()-1]
    } else {
        s
    }
}

#[tauri::command]
async fn open_in_editor(app: tauri::AppHandle, file_path: String, line: u32, editor: Option<String>, template: Option<String>) -> Result<String, String> {
    // 清洗多余的引号（前端某些路径可能被序列化时带了引号）
    let file_path = trim_quotes(&file_path).to_string();
    let editor = editor.as_deref().map(trim_quotes).map(|s| s.to_string());

    eprintln!("[open_in_editor] raw file_path='{file_path}', line={line}, editor={editor:?}, template={template:?}");

    // 兜底：file_path 可能为空（冷启动时序问题），从 AppState 获取
    let file_path = if file_path.is_empty() {
        if let Some(state) = app.try_state::<AppState>() {
            state.opened_file.lock().unwrap().as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
        } else {
            file_path
        }
    } else {
        file_path
    };
    eprintln!("[open_in_editor] resolved file_path='{file_path}'");
    if file_path.is_empty() {
        return Err("未找到文件路径".to_string());
    }

    let line = line + 1; // 转换为 1-based 行号
    let line_str = line.to_string();

    let cmd: String = if let Some(tmpl) = template.filter(|t| !t.is_empty()) {
        tmpl.replace("{file}", &file_path).replace("{line}", &line_str)
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

    // 拆分为 program + args，用 which 解析二进制路径后直接执行
    // 不通过中间 shell，避免 .app PATH 受限找不到编辑器
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    if parts.is_empty() {
        return Err("编辑器命令为空".to_string());
    }

    let program = parts[0];
    let args: Vec<&str> = parts[1..].to_vec();

    // 优先用 which 解析路径（继承当前进程 PATH，终端启动可用）
    // 失败时回退到常见路径
    let resolved = which_path(program);

    let output = app.shell()
        .command(&resolved)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("编辑器: {} — 启动失败: {}", program, e))?;

    if output.status.success() {
        Ok("Editor opened".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("编辑器: {} — 错误: {}", program, stderr))
    }
}

/// 解析命令路径：先查 which，再查常见 homebrew 路径，
/// 最后解析符号链接到真实路径（canonicalize）
fn which_path(name: &str) -> String {
    // 如果是绝对路径，直接返回（Unix /xxx 或 Windows C:\xxx）
    if std::path::Path::new(name).is_absolute() {
        if let Ok(canonical) = std::fs::canonicalize(name) {
            return canonical.to_string_lossy().to_string();
        }
        return name.to_string();
    }

    // 尝试 which（终端启动时继承完整 PATH，能找到）
    if let Ok(output) = std::process::Command::new("which")
        .arg(name)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                // 解析符号链接到真实路径
                if let Ok(canonical) = std::fs::canonicalize(&path) {
                    return canonical.to_string_lossy().to_string();
                }
                return path;
            }
        }
    }

    // 回退：常见路径列表
    let candidates = [
        format!("/opt/homebrew/bin/{}", name),
        format!("/usr/local/bin/{}", name),
        format!("/usr/bin/{}", name),
    ];

    for candidate in &candidates {
        if std::path::Path::new(candidate).exists() {
            if let Ok(canonical) = std::fs::canonicalize(candidate) {
                return canonical.to_string_lossy().to_string();
            }
            return candidate.clone();
        }
    }

    // 都没找到，返回原始名称（让 shell 插件报错）
    name.to_string()
}

#[tauri::command]
fn get_cli_args() -> serde_json::Value {
    let args: Vec<String> = std::env::args().collect();
    let mut editor: Option<String> = None;
    let mut source: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "-e" || args[i] == "--editor" {
            if i + 1 < args.len() {
                editor = Some(args[i + 1].clone());
                i += 1;
            }
        } else if !args[i].starts_with('-') {
            source = Some(args[i].clone());
        }
        i += 1;
    }
    serde_json::json!({ "editor": editor, "source": source })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_args = std::env::args().collect::<Vec<_>>();

    // 单实例检查：如果已有实例运行，转发参数
    if let Ok(mut stream) = std::net::TcpStream::connect(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)) {
        let payload = cli_args.join("\n");
        let _ = stream.write_all(payload.as_bytes());
        println!("Forwarded CLI args to running instance, exiting.");
        return;
    }

    tauri::Builder::default()
        .manage(AppState {
            watched_file: Mutex::new(None),
            stop_watcher: Mutex::new(None),
            opened_file: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![greet, parse_fountain, read_file, export_docx, export_docx_base64, export_pdf, export_pdf_base64, watch_file, unwatch_file, open_in_editor, get_cli_args])
        .setup(move |app| {
            let handle = app.handle().clone();

            // 单实例 TCP 监听（接收后续 CLI 调用转发的参数）
            std::thread::spawn(move || {
                let listener = TcpListener::bind(format!("127.0.0.1:{}", SINGLE_INSTANCE_PORT)).unwrap();
                for stream in listener.incoming() {
                    if let Ok(mut s) = stream {
                        let mut buf = String::new();
                        if s.read_to_string(&mut buf).is_ok() {
                            // payload 格式: "arg0\narg1\narg2\n..."（换行符分隔，避免空格破坏路径）
                            let raw: Vec<&str> = buf.split('\n').filter(|s| !s.is_empty()).collect();
                            // 找到源文件：跳过二进制名（raw[0]），取第一个非 -e/--editor 值的非 flag 参数
                            let mut file: Option<String> = None;
                            let mut ed: Option<String> = None;
                            let mut i = 1;
                            while i < raw.len() {
                                if raw[i] == "-e" || raw[i] == "--editor" {
                                    if i + 1 < raw.len() {
                                        ed = Some(raw[i + 1].to_string());
                                        i += 2;
                                        continue;
                                    }
                                }
                                if !raw[i].starts_with('-') && file.is_none() {
                                    file = Some(raw[i].to_string());
                                }
                                i += 1;
                            }
                            if let Some(ref f) = file {
                                let _ = handle.emit("cli-file", f);
                            }
                            if let Some(ref e) = ed {
                                let _ = handle.emit("cli-editor", e);
                            }
                            if let Some(window) = handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                }
            });

            // 处理 CLI 参数（CLI 启动时）
            if let Ok(cli) = app.cli().matches() {
                if let Some(source) = cli.args.get("source") {
                    let path = source.value.to_string();
                    let _ = app.handle().emit("cli-file", path);
                }
                if let Some(editor) = cli.args.get("editor") {
                    let ed = editor.value.to_string();
                    let _ = app.handle().emit("cli-editor", ed);
                }
            }

            // WebView 就绪后重发 CLI 事件，确保前端能收到
            let h = app.handle().clone();
            if let Ok(cli) = app.cli().matches() {
                let source = cli.args.get("source").map(|s| s.value.to_string());
                let editor = cli.args.get("editor").map(|s| s.value.to_string());
                let h2 = h.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if let Some(ref path) = source {
                        let _ = h2.emit("cli-file", path);
                    }
                    if let Some(ref ed) = editor {
                        let _ = h2.emit("cli-editor", ed);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 处理 macOS 文件关联事件（双击 .fountain 文件打开应用）
            // 同时处理应用已运行时通过 Dock 或 Finder 打开的额外文件
            if let tauri::RunEvent::Opened { urls } = event {
                let files: Vec<String> = urls
                    .into_iter()
                    .filter_map(|url| {
                        // macOS 传递的是 file:// URL
                        if url.scheme() == "file" {
                            url.to_file_path().ok().map(|p| p.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    })
                    .collect();

                if let Some(file_path) = files.first() {
                    eprintln!("[RunEvent::Opened] file_path='{file_path}'");
                    // 存储到 AppState，供前端 get_cli_args 兜底查询
                    let state = app.state::<AppState>();
                    *state.opened_file.lock().unwrap() = Some(PathBuf::from(file_path));
                    eprintln!("[RunEvent::Opened] stored to AppState.opened_file");
                    let handle = app.clone();
                    let path = file_path.clone();
                    // 立即发送一次（覆盖热启动场景，前端已就绪）
                    let _ = app.emit("cli-file", &path);
                    eprintln!("[RunEvent::Opened] emitted cli-file immediately");
                    // 延迟重发，确保冷启动时 WebView 前端已完成 listen 注册
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        let _ = handle.emit("cli-file", &path);
                        eprintln!("[RunEvent::Opened] emitted cli-file delayed");
                    });
                }
            }
        });
}