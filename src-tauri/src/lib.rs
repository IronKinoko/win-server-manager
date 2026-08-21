use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

// 应用级设置（settings.json）
fn default_keep_alive() -> bool {
    // 旧版 settings.json 缺少该字段时保持既有行为：关闭主窗口 = 隐藏到托盘
    true
}

#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    #[serde(default)]
    auto_restore: bool,
    #[serde(default)]
    silent_start: bool,
    // 是否允许关闭主窗口后在后台（托盘）继续运行
    #[serde(default = "default_keep_alive")]
    keep_alive_on_close: bool,
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
    // 正在启动中的任务集合：原子抢占，防止并发调用导致同一任务被启动两次
    starting: Mutex<HashSet<String>>,
    data_dir: PathBuf,
}

impl TaskManager {
    fn new(data_dir: PathBuf) -> Self {
        let tm = Self {
            tasks: Mutex::new(HashMap::new()),
            states: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashSet::new()),
            data_dir,
        };
        tm.load_tasks();
        tm
    }

    /// 尝试占用某任务的启动槽位；任务已在运行或正在启动时返回 false
    fn try_begin_start(&self, id: &str) -> bool {
        let running = self
            .states
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.status == TaskStatus::Running)
            .unwrap_or(false);
        if running {
            return false;
        }
        self.starting.lock().unwrap().insert(id.to_string())
    }

    fn end_start(&self, id: &str) {
        self.starting.lock().unwrap().remove(id);
    }

    /// 清空全部任务日志文件（退出时随停止任务一并调用）
    fn clear_all_logs(&self) {
        let dir = self.data_dir.join("logs");
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
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

    // ---- 设置持久化（settings.json）----

    fn load_settings(&self) -> AppSettings {
        let path = self.data_dir.join("settings.json");
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(s) = serde_json::from_str::<AppSettings>(&content) {
                    return s;
                }
            }
        }
        AppSettings {
            auto_restore: false,
            silent_start: false,
            keep_alive_on_close: default_keep_alive(),
        }
    }

    fn save_settings(&self, s: &AppSettings) {
        let path = self.data_dir.join("settings.json");
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(path, json);
        }
    }

    // ---- 运行中任务快照（running_tasks.json，用于退出/重开后恢复）----

    fn load_running_ids(&self) -> Vec<String> {
        let path = self.data_dir.join("running_tasks.json");
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(ids) = serde_json::from_str::<Vec<String>>(&content) {
                    return ids;
                }
            }
        }
        Vec::new()
    }

    /// 将当前运行中的任务 ID 集合落盘（在状态变化点调用；启动时不要调用，避免覆盖上次快照）。
    /// 退出流程中（QUITTING）必须跳过：退出前已记录好快照，随后逐任务停止，
    /// 若继续写入会把快照覆盖成空集，导致下次启动无任务可恢复。
    fn sync_running_set(&self) {
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let ids: Vec<String> = {
            let states = self.states.lock().unwrap();
            states
                .iter()
                .filter(|(_, s)| s.status == TaskStatus::Running)
                .map(|(id, _)| id.clone())
                .collect()
        };
        let path = self.data_dir.join("running_tasks.json");
        if let Ok(json) = serde_json::to_string(&ids) {
            let _ = std::fs::write(path, json);
        }
    }

    fn get_all(&self) -> Vec<TaskInfo> {
        let tasks = self.tasks.lock().unwrap();
        let states = self.states.lock().unwrap();
        tasks
            .values()
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

// 同步杀死进程树并确认其真正终止。
// 注意必须等待完成：退出流程结束后会立即 app.exit(0)，
// 若 fire-and-forget（仅 spawn 不等待），taskkill 可能来不及执行完，残留进程会继续占用端口等。
fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const NO_WINDOW: u32 = 0x08000000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .output();
        // 最多等约 3 秒确认进程已终止
        for _ in 0..30 {
            if !is_pid_alive(pid) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // 超时则再强制一次并继续等待
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .output();
        for _ in 0..30 {
            if !is_pid_alive(pid) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &format!("-{}", pid)])
            .spawn();
    }
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    let output = match std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH"])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };
    let text = decode_output(&output.stdout);
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 2 && fields[1] == pid.to_string() {
            return true;
        }
    }
    false
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

// 按空白拆分命令行，保留双引号内的内容。
// 支持 \" 与 \\ 转义，避免 JSON 参数中的引号被错误吞掉。
fn parse_command_line(cmdline: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut chars = cmdline.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => {
                // 仅处理最常见的命令行转义：\\ 和 \"；其余场景保留反斜杠原样。
                match chars.peek().copied() {
                    Some('"') => {
                        cur.push('"');
                        let _ = chars.next();
                    }
                    Some('\\') => {
                        cur.push('\\');
                        let _ = chars.next();
                    }
                    _ => cur.push('\\'),
                }
            }
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(ch),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

// 在 PATH 中查找可执行文件
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in [name.to_string(), format!("{}.exe", name)] {
            let p = dir.join(candidate.as_str());
            if p.is_file() {
                return std::fs::canonicalize(&p).ok();
            }
        }
    }
    None
}

// 解析任务的「可执行文件」字段，支持三种写法：
//   1. 绝对/相对路径：C:\server\app.exe
//   2. 仅名称（自动搜索 PATH）：node
//   3. 完整命令行（首个 token 为程序，其余并入参数）：node "D:\AI\server.js"
// 返回 (程序路径, 从命令行解析出的附加参数)
fn resolve_command(raw: &str) -> Result<(PathBuf, Vec<String>), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("可执行文件为空".into());
    }
    // 整个字符串就是有效路径时直接使用
    if let Ok(p) = std::fs::canonicalize(trimmed) {
        return Ok((p, vec![]));
    }
    let tokens = parse_command_line(trimmed);
    let head = tokens[0].clone();
    let rest = tokens[1..].to_vec();
    let program = if head.contains('\\') || head.contains('/') {
        // 带路径分隔符：只按路径解析
        std::fs::canonicalize(&head).ok()
    } else {
        // 纯名称：优先当前目录下的本地文件，再搜 PATH
        std::fs::canonicalize(&head)
            .ok()
            .or_else(|| find_in_path(&head))
    };
    match program {
        Some(p) => Ok((p, rest)),
        None => Err(if rest.is_empty() {
            format!("可执行文件不存在: {}", head)
        } else {
            format!("找不到可执行文件 {}（不在当前目录也不在 PATH 中）", head)
        }),
    }
}

fn do_start_task(app: &AppHandle, tm: &Arc<TaskManager>, task: &Task) -> Result<u32, String> {
    let (exe_path, extra_args) = resolve_command(&task.exe_path)?;

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

    // 启动前清理同名进程，保证单实例（按解析出的真实程序路径判断）
    if kill_same_name_processes(exe_path.to_string_lossy().as_ref()) {
        let _ = app.emit(
            "task-output",
            OutputEvent {
                task_id: task.id.clone(),
                source: "stderr".into(),
                text: format!(
                    "[单实例] 检测到同名进程 {} 正在运行，已终止旧实例\n",
                    exe_path.file_name().and_then(|n| n.to_str()).unwrap_or("?")
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

    // 参数 = 专用参数框的内容（同样做引号感知的拆分）+「可执行文件」里附带的命令行参数
    let mut args: Vec<String> = parse_command_line(&task.arguments);
    args.extend(extra_args);
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
        drop(states);
    }
    tm.sync_running_set();

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
                tm.sync_running_set();
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
                    tm.sync_running_set();
                    let _ = app.emit(
                        "task-status",
                        StatusEvent {
                            task_id: id.clone(),
                            status: TaskStatus::Stopped,
                        },
                    );
                } else {
                    tm.set_status(&id, TaskStatus::Crashed, None);
                    tm.sync_running_set();
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
        task.id = format!(
            "task_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
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
    let status = st.map(|s| s.status.clone()).unwrap_or(TaskStatus::Stopped);
    let pid = st.and_then(|s| s.pid);
    drop(states);

    Ok(TaskInfo { task, status, pid })
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
    drop(states);
    state.sync_running_set();

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

    // 原子抢占启动槽位：任务已在运行或已有并发启动在进行时直接拒绝，避免同一任务被拉起两个进程
    if !tm.try_begin_start(&id) {
        return Err("任务已在运行中".into());
    }
    let result = do_start_task(&app, &tm, &task);
    tm.end_start(&id);
    result
}

#[tauri::command]
fn stop_task(app: AppHandle, state: State<'_, Arc<TaskManager>>, id: String) -> Result<(), String> {
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
    tm.sync_running_set();
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
    tm.sync_running_set();
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

// ---- 设置与运行快照 ----

#[tauri::command]
fn get_setting_auto_restore(state: State<'_, Arc<TaskManager>>) -> bool {
    state.load_settings().auto_restore
}

#[tauri::command]
fn set_setting_auto_restore(state: State<'_, Arc<TaskManager>>, value: bool) {
    let mut s = state.load_settings();
    s.auto_restore = value;
    state.save_settings(&s);
}

#[tauri::command]
fn get_setting_silent_start(state: State<'_, Arc<TaskManager>>) -> bool {
    state.load_settings().silent_start
}

#[tauri::command]
fn set_setting_silent_start(state: State<'_, Arc<TaskManager>>, value: bool) {
    let mut s = state.load_settings();
    s.silent_start = value;
    state.save_settings(&s);
}

#[tauri::command]
fn get_setting_keep_alive(state: State<'_, Arc<TaskManager>>) -> bool {
    state.load_settings().keep_alive_on_close
}

#[tauri::command]
fn set_setting_keep_alive(state: State<'_, Arc<TaskManager>>, value: bool) {
    let mut s = state.load_settings();
    s.keep_alive_on_close = value;
    state.save_settings(&s);
}

// ---- 开机自启（HKCU\...\Run 注册表项）----

#[cfg(target_os = "windows")]
const AUTOSTART_REG_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const AUTOSTART_REG_NAME: &str = "win-server-manager";

#[tauri::command]
fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        let reg = winreg::RegKey::predef(HKEY_CURRENT_USER);
        match reg.open_subkey_with_flags(AUTOSTART_REG_KEY, KEY_READ) {
            Ok(run) => run
                .get_value::<String, _>(AUTOSTART_REG_NAME)
                .map_or(false, |v| !v.trim().is_empty()),
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
fn set_autostart(value: bool) {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
        let reg = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let Ok((run, _)) = reg.create_subkey_with_flags(AUTOSTART_REG_KEY, KEY_WRITE) else {
            return;
        };
        if value {
            if let Ok(exe) = std::env::current_exe() {
                // 路径带引号，兼容含空格/中文的安装目录
                let _ = run.set_value(AUTOSTART_REG_NAME, &format!("\"{}\"", exe.display()));
            }
        } else {
            let _ = run.delete_value(AUTOSTART_REG_NAME);
        }
    }
}

#[tauri::command]
fn get_running_task_ids(state: State<'_, Arc<TaskManager>>) -> Vec<String> {
    state.load_running_ids()
}

// ==================== 应用入口 ====================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// 统一退出流程（托盘「退出应用」与禁用后台继续运行时关闭主窗口共用）：
// 若开启「自动恢复任务」则保存运行快照并停止全部任务，下次启动时恢复；
// 未开启则进程保持在后台运行，也不做恢复
fn perform_quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(tm) = app.try_state::<Arc<TaskManager>>() {
        if tm.load_settings().auto_restore {
            tm.sync_running_set();
            stop_all_tasks(app, &tm);
        }
        // 无论何种模式，退出都清空所有任务日志，重启后不残留上一轮输出
        tm.clear_all_logs();
    }
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            let task_manager = Arc::new(TaskManager::new(data_dir));
            app.manage(task_manager.clone());

            // 窗口配置为创建时不可见，避免静默启动时闪现：
            // 非静默 → 立即显示；静默 → 保持隐藏，驻留托盘（左键单击随时唤回）
            if !task_manager.load_settings().silent_start {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                }
            }

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
            // 关闭窗口：默认隐藏到托盘继续后台运行；
            // 若设置中关闭了「允许后台继续运行」，则等同于退出应用
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    let keep_alive = window
                        .app_handle()
                        .try_state::<Arc<TaskManager>>()
                        .map(|tm| tm.load_settings().keep_alive_on_close)
                        .unwrap_or(true);
                    if keep_alive {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        perform_quit(&window.app_handle());
                    }
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
                    // 退出：与禁用后台继续运行时关闭主窗口走同一流程
                    perform_quit(app);
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
            clear_task_log,
            get_setting_auto_restore,
            set_setting_auto_restore,
            get_setting_silent_start,
            set_setting_silent_start,
            get_setting_keep_alive,
            set_setting_keep_alive,
            get_autostart,
            set_autostart,
            get_running_task_ids
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
