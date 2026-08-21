use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tokio::io::AsyncReadExt;

// 标记应用是否正在真正退出（区别于"隐藏到托盘"）
static QUITTING: AtomicBool = AtomicBool::new(false);

// ==================== 数据模型 ====================

#[derive(Serialize, Deserialize, Clone)]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub arguments: String,
    pub working_dir: String,
    pub env_vars: Vec<EnvVar>,
    pub auto_restart: bool,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Stopped,
    Running,
    Crashed,
}

#[derive(Serialize, Clone)]
pub struct TaskInfo {
    pub task: Task,
    pub status: TaskStatus,
    pub pid: Option<u32>,
}

#[derive(Serialize, Clone)]
pub struct OutputEvent {
    pub task_id: String,
    pub source: String,
    pub text: String,
}

#[derive(Serialize, Clone)]
pub struct StatusEvent {
    pub task_id: String,
    pub status: TaskStatus,
}

// ==================== 任务管理器 ====================

struct TaskState {
    status: TaskStatus,
    pid: Option<u32>,
    stop_tx: Option<tokio::sync::watch::Sender<bool>>,
}

pub struct TaskManager {
    tasks: Mutex<HashMap<String, Task>>,
    states: Mutex<HashMap<String, TaskState>>,
    data_dir: PathBuf,
}

impl TaskManager {
    fn new(data_dir: PathBuf) -> Self {
        let tm = Self {
            tasks: Mutex::new(HashMap::new()),
            states: Mutex::new(HashMap::new()),
            data_dir,
        };
        tm.load_tasks();
        tm
    }

    fn load_tasks(&self) {
        let path = self.data_dir.join("tasks.json");
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(tasks) = serde_json::from_str::<Vec<Task>>(&content) {
                    let mut map = self.tasks.lock().unwrap();
                    for task in tasks {
                        map.insert(task.id.clone(), task);
                    }
                }
            }
        }
    }

    fn save_tasks(&self) {
        let path = self.data_dir.join("tasks.json");
        let tasks = self.tasks.lock().unwrap();
        let vec: Vec<&Task> = tasks.values().collect();
        if let Ok(json) = serde_json::to_string_pretty(&vec) {
            let _ = std::fs::write(&path, json);
        }
    }

    fn get_all(&self) -> Vec<TaskInfo> {
        let tasks = self.tasks.lock().unwrap();
        let states = self.states.lock().unwrap();
        tasks.values()
            .map(|t| {
                let state = states.get(&t.id);
                TaskInfo {
                    task: t.clone(),
                    status: state
                        .map(|s| s.status.clone())
                        .unwrap_or(TaskStatus::Stopped),
                    pid: state.and_then(|s| s.pid),
                }
            })
            .collect()
    }

    fn set_status(&self, id: &str, status: TaskStatus, pid: Option<u32>) {
        let mut states = self.states.lock().unwrap();
        if let Some(s) = states.get_mut(id) {
            s.status = status;
            s.pid = pid;
        }
    }

    fn request_stop(&self, id: &str) -> bool {
        let mut states = self.states.lock().unwrap();
        if let Some(s) = states.get_mut(id) {
            if let Some(ref tx) = s.stop_tx {
                let _ = tx.send(true);
                return true;
            }
        }
        false
    }
}

// ==================== 工具函数 ====================

fn decode_output(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let (s, _, _) = encoding_rs::GBK.decode(bytes);
    s.to_string()
}

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .spawn();
    }
}

// 启动前检查是否有来自同一文件的同名进程在运行，若有则终止，保证单实例
fn kill_same_name_processes(exe_path: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let file_name = Path::new(exe_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        // 仅处理 .exe，避免 .bat/.cmd 误杀 cmd.exe
        if !file_name.to_ascii_lowercase().ends_with(".exe") {
            return false;
        }
        // 规范化任务可执行文件路径，用于与进程实际路径比对
        let target = std::fs::canonicalize(exe_path)
            .unwrap_or_else(|_| PathBuf::from(exe_path))
            .to_string_lossy()
            .to_ascii_lowercase();

        // 通过 PowerShell 查询同名进程的 PID 与完整路径
        let ps_cmd = format!(
            "Get-Process -Name '{}' -ErrorAction SilentlyContinue | ForEach-Object {{ \"$($_.Id) $($_.Path)\" }}",
            file_name
        );
        let output = match std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .creation_flags(0x08000000)
            .output()
        {
            Ok(o) => o,
            Err(_) => return false,
        };
        let text = decode_output(&output.stdout);

        // 逐行解析 "PID 路径"，仅终止路径与任务文件一致的进程
        let mut killed = false;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let mut parts = line.splitn(2, ' ');
            let pid = match parts.next().and_then(|p| p.parse::<u32>().ok()) {
                Some(pid) => pid,
                None => continue,
            };
            let proc_path = parts.next().unwrap_or("").trim();
            if proc_path.is_empty() {
                continue;
            }
            let proc_path = std::fs::canonicalize(proc_path)
                .unwrap_or_else(|_| PathBuf::from(proc_path))
                .to_string_lossy()
                .to_ascii_lowercase();
            if proc_path == target {
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .spawn();
                killed = true;
            }
        }
        if killed {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        killed
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = exe_path;
        false
    }
}

// ==================== 核心启动逻辑 ====================

fn do_start_task(
    app: &AppHandle,
    tm: &Arc<TaskManager>,
    task: &Task,
) -> Result<u32, String> {
    let exe_path = match std::fs::canonicalize(&task.exe_path) {
        Ok(path) => path,
        Err(_) => {
            return Err(format!("可执行文件不存在: {}", task.exe_path));
        }
    };

    // 每次启动清空该任务的日志与前端输出，保证输出区只反映本次运行
    {
        let log_dir = tm.data_dir.join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log_path = log_dir.join(format!("{}.log", task.id));
        std::fs::File::create(&log_path).ok();
    }
    let _ = app.emit(
        "task-output-clear",
        serde_json::json!({ "task_id": task.id }),
    );

    // 启动前清理同名进程，保证单实例
    if kill_same_name_processes(&task.exe_path) {
        let _ = app.emit(
            "task-output",
            OutputEvent {
                task_id: task.id.clone(),
                source: "stderr".into(),
                text: format!(
                    "[单实例] 检测到同名进程 {} 正在运行，已终止旧实例\n",
                    Path::new(&task.exe_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("?")
                ),
            },
        );
    }

    let mut cmd = tokio::process::Command::new(&exe_path);

    let working_dir = if task.working_dir.trim().is_empty() {
        exe_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
    } else {
        Path::new(&task.working_dir)
    };
    cmd.current_dir(working_dir);

    let args: Vec<String> = task
        .arguments
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    cmd.args(&args);

    for env in &task.env_vars {
        cmd.env(&env.key, &env.value);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动失败: {}", e))?;
    let pid = child.id().ok_or("无法获取进程 PID")?;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

    {
        let mut states = tm.states.lock().unwrap();
        let state = states.entry(task.id.clone()).or_insert(TaskState {
            status: TaskStatus::Stopped,
            pid: None,
            stop_tx: None,
        });
        state.status = TaskStatus::Running;
        state.pid = Some(pid);
        state.stop_tx = Some(stop_tx);
    }

    let _ = app.emit(
        "task-status",
        StatusEvent {
            task_id: task.id.clone(),
            status: TaskStatus::Running,
        },
    );

    let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
    let stderr = child.stderr.take().ok_or("无法获取 stderr")?;

    let log_dir = tm.data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let log_path = log_dir.join(format!("{}.log", task.id));

    // ---- 异步读取 stdout ----
    {
        let app = app.clone();
        let id = task.id.clone();
        let log_path = log_path.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut buf = [0u8; 8192];
            let mut line_buf: Vec<u8> = Vec::new();
            let mut log_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();

            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => {
                        if !line_buf.is_empty() {
                            let text = decode_output(&line_buf);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stdout".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                        }
                        break;
                    }
                    Ok(n) => {
                        line_buf.extend_from_slice(&buf[..n]);
                        if let Some(last_nl) = line_buf.iter().rposition(|&b| b == b'\n') {
                            let (complete, remaining) = line_buf.split_at(last_nl + 1);
                            let text = decode_output(complete);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stdout".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                            line_buf = remaining.to_vec();
                        }
                        if line_buf.len() > 65536 {
                            let text = decode_output(&line_buf);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stdout".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                            line_buf.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- 异步读取 stderr ----
    {
        let app = app.clone();
        let id = task.id.clone();
        let log_path = log_path.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf = [0u8; 8192];
            let mut line_buf: Vec<u8> = Vec::new();
            let mut log_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();

            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => {
                        if !line_buf.is_empty() {
                            let text = decode_output(&line_buf);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stderr".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                        }
                        break;
                    }
                    Ok(n) => {
                        line_buf.extend_from_slice(&buf[..n]);
                        if let Some(last_nl) = line_buf.iter().rposition(|&b| b == b'\n') {
                            let (complete, remaining) = line_buf.split_at(last_nl + 1);
                            let text = decode_output(complete);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stderr".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                            line_buf = remaining.to_vec();
                        }
                        if line_buf.len() > 65536 {
                            let text = decode_output(&line_buf);
                            if !text.is_empty() {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stderr".into(),
                                        text: text.clone(),
                                    },
                                );
                                if let Some(ref mut f) = log_file {
                                    use std::io::Write;
                                    let _ = f.write_all(text.as_bytes());
                                }
                            }
                            line_buf.clear();
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // ---- 进程监控（等待退出 + 自动重启）----
    {
        let app = app.clone();
        let id = task.id.clone();
        let tm = tm.clone();
        let auto_restart = task.auto_restart;
        let task_clone = task.clone();
        tokio::spawn(async move {
            let exit_status = child.wait().await;
            let stop_requested = *stop_rx.borrow();

            if stop_requested {
                tm.set_status(&id, TaskStatus::Stopped, None);
                let _ = app.emit(
                    "task-status",
                    StatusEvent {
                        task_id: id.clone(),
                        status: TaskStatus::Stopped,
                    },
                );
            } else if let Ok(status) = exit_status {
                if status.success() {
                    tm.set_status(&id, TaskStatus::Stopped, None);
                    let _ = app.emit(
                        "task-status",
                        StatusEvent {
                            task_id: id.clone(),
                            status: TaskStatus::Stopped,
                        },
                    );
                } else {
                    tm.set_status(&id, TaskStatus::Crashed, None);
                    let _ = app.emit(
                        "task-status",
                        StatusEvent {
                            task_id: id.clone(),
                            status: TaskStatus::Crashed,
                        },
                    );

                    if auto_restart {
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        if !*stop_rx.borrow() {
                            if let Err(e) = do_start_task(&app, &tm, &task_clone) {
                                let _ = app.emit(
                                    "task-output",
                                    OutputEvent {
                                        task_id: id.clone(),
                                        source: "stderr".into(),
                                        text: format!("[自动重启失败] {}\n", e),
                                    },
                                );
                            }
                        }
                    }
                }
            }
        });
    }

    Ok(pid)
}

// ==================== Tauri 命令 ====================

#[tauri::command]
fn get_tasks(state: State<'_, Arc<TaskManager>>) -> Vec<TaskInfo> {
    state.get_all()
}

#[tauri::command]
fn add_task(state: State<'_, Arc<TaskManager>>, mut task: Task) -> Result<TaskInfo, String> {
    if task.id.is_empty() {
        task.id = format!("task_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    }
    let mut tasks = state.tasks.lock().unwrap();
    if tasks.contains_key(&task.id) {
        return Err("任务 ID 已存在".into());
    }
    tasks.insert(task.id.clone(), task.clone());
    drop(tasks);
    state.save_tasks();

    let mut states = state.states.lock().unwrap();
    states.insert(
        task.id.clone(),
        TaskState {
            status: TaskStatus::Stopped,
            pid: None,
            stop_tx: None,
        },
    );
    drop(states);

    Ok(TaskInfo {
        task,
        status: TaskStatus::Stopped,
        pid: None,
    })
}

#[tauri::command]
fn update_task(state: State<'_, Arc<TaskManager>>, task: Task) -> Result<TaskInfo, String> {
    let mut tasks = state.tasks.lock().unwrap();
    if !tasks.contains_key(&task.id) {
        return Err("任务不存在".into());
    }
    tasks.insert(task.id.clone(), task.clone());
    drop(tasks);
    state.save_tasks();

    let states = state.states.lock().unwrap();
    let st = states.get(&task.id);
    let status = st
        .map(|s| s.status.clone())
        .unwrap_or(TaskStatus::Stopped);
    let pid = st.and_then(|s| s.pid);
    drop(states);

    Ok(TaskInfo {
        task,
        status,
        pid,
    })
}

#[tauri::command]
fn delete_task(state: State<'_, Arc<TaskManager>>, id: String) -> Result<(), String> {
    let pid = {
        let states = state.states.lock().unwrap();
        states.get(&id).and_then(|s| s.pid)
    };

    state.request_stop(&id);

    if let Some(pid) = pid {
        kill_process_tree(pid);
    }

    let mut tasks = state.tasks.lock().unwrap();
    tasks.remove(&id);
    drop(tasks);
    state.save_tasks();

    let mut states = state.states.lock().unwrap();
    states.remove(&id);

    Ok(())
}

#[tauri::command]
async fn start_task(
    app: AppHandle,
    state: State<'_, Arc<TaskManager>>,
    id: String,
) -> Result<u32, String> {
    let tm = state.inner().clone();
    let task = {
        let tasks = tm.tasks.lock().unwrap();
        tasks.get(&id).cloned().ok_or("任务不存在")?
    };

    {
        let states = tm.states.lock().unwrap();
        if let Some(s) = states.get(&id) {
            if s.status == TaskStatus::Running {
                return Err("任务已在运行中".into());
            }
        }
    }

    do_start_task(&app, &tm, &task)
}

#[tauri::command]
fn stop_task(
    app: AppHandle,
    state: State<'_, Arc<TaskManager>>,
    id: String,
) -> Result<(), String> {
    let tm = state.inner().clone();

    let pid = {
        let states = tm.states.lock().unwrap();
        states.get(&id).and_then(|s| s.pid)
    };

    tm.request_stop(&id);

    if let Some(pid) = pid {
        kill_process_tree(pid);
    }

    tm.set_status(&id, TaskStatus::Stopped, None);
    let _ = app.emit(
        "task-status",
        StatusEvent {
            task_id: id,
            status: TaskStatus::Stopped,
        },
    );

    Ok(())
}

// 停止所有运行中的任务（应用退出时调用）
fn stop_all_tasks(app: &AppHandle, tm: &Arc<TaskManager>) {
    let ids: Vec<String> = {
        let states = tm.states.lock().unwrap();
        states
            .iter()
            .filter(|(_, s)| s.status == TaskStatus::Running)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in ids {
        let pid = {
            let states = tm.states.lock().unwrap();
            states.get(&id).and_then(|s| s.pid)
        };
        tm.request_stop(&id);
        if let Some(pid) = pid {
            kill_process_tree(pid);
        }
        tm.set_status(&id, TaskStatus::Stopped, None);
        let _ = app.emit(
            "task-status",
            StatusEvent {
                task_id: id.clone(),
                status: TaskStatus::Stopped,
            },
        );
    }
}

#[tauri::command]
fn get_task_log(state: State<'_, Arc<TaskManager>>, id: String) -> String {
    let path = state.data_dir.join("logs").join(format!("{}.log", id));
    std::fs::read_to_string(&path).unwrap_or_default()
}

#[tauri::command]
fn clear_task_log(state: State<'_, Arc<TaskManager>>, id: String) -> Result<(), String> {
    let path = state.data_dir.join("logs").join(format!("{}.log", id));
    if path.exists() {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            let task_manager = Arc::new(TaskManager::new(data_dir));
            app.manage(task_manager.clone());

            // 托盘图标在 tauri.conf.json 的 app.trayIcon 中定义，这里为其设置右键菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_menu(Some(tray_menu));
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口时隐藏到托盘，而非退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .on_tray_icon_event(|app, event| {
            // 左键单击：显示并聚焦窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    // 退出：停止所有任务后退出应用
                    QUITTING.store(true, Ordering::SeqCst);
                    if let Some(tm) = app.try_state::<Arc<TaskManager>>() {
                        stop_all_tasks(app, &tm);
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks,
            add_task,
            update_task,
            delete_task,
            start_task,
            stop_task,
            get_task_log,
            clear_task_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
