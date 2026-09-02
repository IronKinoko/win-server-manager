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
pub struct Task {
    pub id: String,
    pub name: String,
    pub exe_path: String,
    pub arguments: String,
    pub working_dir: String,
    pub auto_restart: bool,
    // 应用启动时自动运行；旧版 tasks.json 缺少该字段时默认关闭
    #[serde(default)]
    pub auto_run_on_launch: bool,
    // 自定义美化输出代码（前端 new Function 求值）；旧版 tasks.json 缺少该字段时视为 None，
    // 为空时不落盘，保持 tasks.json 整洁
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pretty_code: Option<String>,
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

struct DockerRunCommand {
    args: Vec<String>,
    stop_args: Vec<String>,
    container_name: String,
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

    /// 取出所有开启「应用启动时自动运行」的任务 ID
    fn auto_run_on_launch_ids(&self) -> Vec<String> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, t)| t.auto_run_on_launch)
            .map(|(id, _)| id.clone())
            .collect()
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

// ==================== Windows ConPTY ====================
//
// 常规「管道 + CREATE_NO_WINDOW」方式启动的子进程把 stdout 看作管道（isatty 失败），
// 多数程序（git / cargo / node / .NET 等）会自行关掉 ANSI 颜色；
// 本模块用伪控制台（ConPTY，Win10+）让子进程认为自己挂在真实控制台上，
// 其 ANSI 输出（stdout+stderr 合并、带转义序列）从 pty 输出管完整读回。

#[cfg(target_os = "windows")]
mod conpty {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct Coord {
        pub x: i16,
        pub y: i16,
    }

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        lp_security_descriptor: usize,
        b_inherit_handle: i32,
    }

    type CreatePseudoConsoleFn = extern "system" fn(
        size: *const Coord,
        h_input: usize,
        h_output: usize,
        dw_flags: u32,
        ph_pty: *mut usize,
    ) -> i32;

    type ClosePseudoConsoleFn = extern "system" fn(h_pty: usize) -> i32;

    extern "system" {
        fn LoadLibraryA(lp_lib_filename: *const u8) -> usize;
        fn GetProcAddress(h_module: usize, lp_proc_name: *const u8) -> usize;
        fn CreatePipe(
            ph_read_pipe: *mut usize,
            ph_write_pipe: *mut usize,
            lp_pipe_attributes: *const SecurityAttributes,
            n_size: usize,
        ) -> i32;
    }

    // ConPTY 入口点在 Win8.1 及更早系统不存在，按序从各版本 dll 动态查找；
    // 查找成功后不 FreeLibrary，让函数指针在整个进程生命周期内有效
    fn load_conpty_api() -> Option<(CreatePseudoConsoleFn, ClosePseudoConsoleFn)> {
        use std::ffi::CString;
        unsafe {
            let names: [CString; 3] = [
                CString::new("api-ms-win-conpty-l1-1-0.dll").unwrap(),
                CString::new("api-ms-win-conpty-l1-1-1.dll").unwrap(),
                CString::new("kernel32.dll").unwrap(),
            ];
            for name in &names {
                let lib = LoadLibraryA(name.as_ptr() as *const u8);
                if lib == 0 {
                    continue;
                }
                let create = GetProcAddress(
                    lib,
                    CString::new("CreatePseudoConsole").unwrap().as_ptr() as *const u8,
                );
                let close = GetProcAddress(
                    lib,
                    CString::new("ClosePseudoConsole").unwrap().as_ptr() as *const u8,
                );
                if create != 0 && close != 0 {
                    return Some((
                        std::mem::transmute::<usize, CreatePseudoConsoleFn>(create),
                        std::mem::transmute::<usize, ClosePseudoConsoleFn>(close),
                    ));
                }
            }
        }
        None
    }

    fn create_inheritable_pipe(size: usize) -> Option<(OwnedHandle, OwnedHandle)> {
        unsafe {
            let sa = SecurityAttributes {
                n_length: std::mem::size_of::<SecurityAttributes>() as u32,
                lp_security_descriptor: 0,
                b_inherit_handle: 1,
            };
            let mut read: usize = 0;
            let mut write: usize = 0;
            if CreatePipe(&mut read, &mut write, &sa, size) == 0 {
                return None;
            }
            Some((
                OwnedHandle::from_raw_handle(read as *mut std::ffi::c_void),
                OwnedHandle::from_raw_handle(write as *mut std::ffi::c_void),
            ))
        }
    }

    /// 伪控制台实例：
    /// - `handle`：交给子进程 stdin/stdout/stderr 的 pty 句柄（用 try_clone 复制使用）
    /// - `output_read`：输出管道读端，供构建读取流
    /// - 输入管道写端由结构体持有，drop 时关闭，保持 pty 输入管道存活
    pub struct Pty {
        pub handle: OwnedHandle,
        pub output_read: OwnedHandle,
        #[allow(dead_code)] // 仅用于保持打开，从不读取
        input_write: OwnedHandle,
    }

    /// 创建 ConPTY；失败（如 Win8.1 及以下）返回 None，调用方回退到普通管道
    pub fn create_pty(width: i16, height: i16) -> Option<Pty> {
        let api = load_conpty_api()?;
        let (input_read, input_write) = create_inheritable_pipe(0)?;
        let (output_read, output_write) = create_inheritable_pipe(1 << 20)?;
        let mut pty: usize = 0;
        let size = Coord {
            x: width,
            y: height,
        };
        if (api.0)(
            &size,
            input_read.as_raw_handle() as usize,
            output_write.as_raw_handle() as usize,
            0,
            &mut pty,
        ) == 0
        {
            return None;
        }
        // CreatePseudoConsole 内部持有 input_read / output_write 的副本，
        // 本进程可以立刻释放它们（与 WindowsTerminal 的做法一致）
        drop(input_read);
        drop(output_write);
        Some(Pty {
            handle: unsafe { OwnedHandle::from_raw_handle(pty as *mut std::ffi::c_void) },
            output_read,
            input_write,
        })
    }

    impl Pty {
        /// 关闭伪控制台（尽力而为：子进程退出后 pty 通常已随之销毁）
        pub fn close(&self) {
            if let Some((_, close)) = load_conpty_api() {
                (close)(self.handle.as_raw_handle() as usize);
            }
        }
    }
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

// Windows：按 PATHEXT 环境变量顺序尝试的可执行扩展名（如 .COM;.EXE;.BAT;.CMD）
#[cfg(target_os = "windows")]
fn path_extensions() -> Vec<String> {
    match std::env::var("PATHEXT") {
        Ok(v) if !v.trim().is_empty() => v
            .split(';')
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_ascii_uppercase())
            .collect(),
        _ => vec![
            ".COM".to_string(),
            ".EXE".to_string(),
            ".BAT".to_string(),
            ".CMD".to_string(),
        ],
    }
}

// 生成在单个目录内应尝试的候选文件名，遵循 Windows 命令行解析语义：
//   - 名称未带可执行扩展名（node / npm）→ 按 PATHEXT 顺序补全（node → node.exe …）。
//     这样 npm（只有 npm.cmd 批处理 + 无扩展名 POSIX shim）能命中 npm.cmd，
//     而不是无扩展名的 shim（直接 spawn 会报 os error 193「不是有效的 Win32 应用程序」）。
//   - 名称已带可执行扩展名（frpc.exe / app.bat）→ 只用原名本身，
//     避免叠加出 frpc.exe.EXE 这类不存在的候选，从而漏掉真实存在的文件。
// 非 Windows：可执行文件不带扩展名，直接用原名。
fn candidate_names(name: &str) -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let lower = name.to_ascii_lowercase();
        let has_exec_ext = [".exe", ".com", ".bat", ".cmd"]
            .iter()
            .any(|e| lower.ends_with(e));
        if has_exec_ext {
            return vec![name.to_string()];
        }
        path_extensions()
            .into_iter()
            .map(|ext| format!("{}{}", name, ext))
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![name.to_string()]
    }
}

// 在 PATH 中查找可执行文件（见 candidate_names 的候选名生成规则）。
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    let names = candidate_names(name);
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in &names {
            let p = dir.join(candidate);
            if p.is_file() {
                return std::fs::canonicalize(&p).ok();
            }
        }
    }
    None
}

// Windows：给定路径没有可识别的可执行扩展名时，按 PATHEXT 顺序补全扩展名再解析。
// 例如显式填写 C:\...\npm（无扩展名 shim）时会改解析为 C:\...\npm.cmd。
#[cfg(target_os = "windows")]
fn extend_with_pathtext(raw: &str) -> Option<PathBuf> {
    let lower = raw.to_ascii_lowercase();
    if [".exe", ".com", ".bat", ".cmd"]
        .iter()
        .any(|e| lower.ends_with(e))
    {
        return None;
    }
    for ext in path_extensions() {
        if let Ok(p) = std::fs::canonicalize(format!("{}{}", raw, ext)) {
            return Some(p);
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn extend_with_pathtext(_raw: &str) -> Option<PathBuf> {
    None
}

// 在指定目录内按 candidate_names 的候选名规则查找。
// 命中的相对路径保持相对形式返回，由进程 current_dir 定位，
// 避免对尚不存在的子进程工作目录做 canonicalize 失败。
fn find_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    for candidate in candidate_names(name) {
        let p = dir.join(&candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

// 解析纯程序名：
//   先在任务工作目录中查找（含 PATHEXT 补全），再按平台 shell 语义回退 PATH。
//   这样「工作目录下放个脚本，exe 只写名字」的用法无需填完整路径。
fn resolve_bare_name(name: &str, workdir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = workdir {
        if !dir.as_os_str().is_empty() {
            if let Some(p) = find_in_dir(dir, name) {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        find_in_path(name).or_else(|| std::fs::canonicalize(name).ok())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::fs::canonicalize(name)
            .ok()
            .or_else(|| find_in_path(name))
    }
}

// 解析任务的「可执行文件」字段，支持三种写法：
//   1. 绝对/相对路径：C:\server\app.exe（相对路径基于任务工作目录解析）
//   2. 仅名称（先搜任务工作目录，再搜 PATH）：node / 同目录下的脚本
//   3. 完整命令行（首个 token 为程序，其余并入参数）：node "D:\AI\server.js"
// workdir 为 None（未配置工作目录）时不做本地优先查找。
// 返回 (程序路径, 从命令行解析出的附加参数)
fn resolve_command(raw: &str, workdir: Option<&Path>) -> Result<(PathBuf, Vec<String>), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("可执行文件为空".into());
    }
    let tokens = parse_command_line(trimmed);
    let head = tokens[0].clone();
    let rest = tokens[1..].to_vec();
    let program = if head.contains('\\') || head.contains('/') {
        // 带路径分隔符：绝对路径直接解析，相对路径基于任务工作目录；
        // Windows 上路径无扩展名（如裸写 npm）时按 PATHEXT 补全
        let base = match workdir {
            Some(dir) if !Path::new(&head).is_absolute() => dir.join(&head),
            _ => PathBuf::from(&head),
        };
        std::fs::canonicalize(&base)
            .ok()
            .or_else(|| extend_with_pathtext(base.to_string_lossy().as_ref()))
    } else {
        // 纯名称：先查任务工作目录，再回退 PATH（见 resolve_bare_name）
        resolve_bare_name(&head, workdir)
    };
    match program {
        Some(p) => Ok((p, rest)),
        None => Err(if rest.is_empty() {
            format!("可执行文件不存在: {}", head)
        } else {
            format!("找不到可执行文件 {}（不在工作目录也不在 PATH 中）", head)
        }),
    }
}

// 换行已经由 parse_command_line 视为普通空白。只匹配相邻的 `docker run`，
// 避免误把镜像名、环境变量值等文本当作 Docker 子命令。
fn prepare_docker_run(task_id: &str, mut args: Vec<String>) -> Option<DockerRunCommand> {
    let run_index = args.windows(2).position(|pair| {
        pair[0].eq_ignore_ascii_case("docker") && pair[1].eq_ignore_ascii_case("run")
    })? + 1;
    let name_index = args
        .iter()
        .enumerate()
        .skip(run_index + 1)
        .find_map(|(index, arg)| {
            if arg == "--name" {
                args.get(index + 1)
                    .filter(|name| !name.starts_with('-'))
                    .map(|_| index)
            } else {
                None
            }
        });
    let container_name = if let Some(index) = name_index {
        args[index + 1].clone()
    } else if let Some(name) = args
        .iter()
        .skip(run_index + 1)
        .find_map(|arg| arg.strip_prefix("--name="))
        .filter(|name| !name.is_empty())
    {
        name.to_string()
    } else {
        let suffix: String = task_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-') {
                    ch
                } else {
                    '-'
                }
            })
            .collect();
        let name = format!("win-server-manager-{}", suffix);
        args.insert(run_index + 1, format!("--name={}", name));
        name
    };

    let mut stop_args = args[..run_index - 1].to_vec();
    stop_args.extend([
        "docker".to_string(),
        "stop".to_string(),
        container_name.clone(),
    ]);
    Some(DockerRunCommand {
        args,
        stop_args,
        container_name,
    })
}

// Docker 容器由守护进程拥有，结束 docker CLI 或 wsl.exe 后仍可能继续运行。
// 对由本任务启动的 `docker run`，使用相同入口（原生 Docker 或 WSL）发送 docker stop。
fn stop_docker_container(task: &Task) -> Result<Option<String>, String> {
    let explicit_workdir = if task.working_dir.trim().is_empty() {
        None
    } else {
        Some(Path::new(task.working_dir.trim()))
    };
    let (program, extra_args) = resolve_command(&task.exe_path, explicit_workdir)?;
    let mut args = parse_command_line(&task.arguments);
    args.extend(extra_args);
    let Some(docker) = prepare_docker_run(&task.id, args) else {
        return Ok(None);
    };

    let mut command = std::process::Command::new(program);
    command.args(&docker.stop_args);
    if let Some(workdir) = explicit_workdir {
        command.current_dir(workdir);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command
        .output()
        .map_err(|e| format!("执行 docker stop 失败: {}", e))?;
    if output.status.success() {
        Ok(Some(docker.container_name))
    } else {
        let stderr = decode_output(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("docker stop 退出状态: {}", output.status)
        } else {
            format!("docker stop 失败: {}", stderr)
        })
    }
}

// ConPTY 输出流包装：AsyncRead 委托给输出管道文件；
// drop 时（读取结束/任务停止）调用 ClosePseudoConsole 并释放各管道句柄
#[cfg(target_os = "windows")]
struct PtyReader {
    inner: tokio::fs::File,
    pty: conpty::Pty,
}

#[cfg(target_os = "windows")]
impl tokio::io::AsyncRead for PtyReader {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        tokio::io::AsyncRead::poll_read(std::pin::Pin::new(&mut self.inner), cx, buf)
    }
}

#[cfg(target_os = "windows")]
impl Drop for PtyReader {
    fn drop(&mut self) {
        self.pty.close();
    }
}

// 读取子进程输出流：按 \n 切块（保留行尾换行与 ANSI 序列），
// 逐块发给前端并追加写入日志文件；解码规则见 decode_output（UTF-8 失败回退 GBK）
fn spawn_output_reader(
    app: &AppHandle,
    id: &str,
    log_path: &Path,
    source: &str,
    reader: impl tokio::io::AsyncRead + std::marker::Unpin + Send + 'static,
) {
    let app = app.clone();
    let id = id.to_string();
    let source = source.to_string();
    let log_path = log_path.to_path_buf();
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(reader);
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
                                    source: source.clone(),
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
                                    source: source.clone(),
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
                                    source: source.clone(),
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

fn do_start_task(app: &AppHandle, tm: &Arc<TaskManager>, task: &Task) -> Result<u32, String> {
    // 先确定任务配置的工作目录：可执行文件解析从该目录开始（纯名称优先本地查找）
    let explicit_workdir = if task.working_dir.trim().is_empty() {
        None
    } else {
        Some(Path::new(task.working_dir.trim()))
    };
    let (exe_path, extra_args) = resolve_command(&task.exe_path, explicit_workdir)?;

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

    let mut cmd = tokio::process::Command::new(&exe_path);

    // 未配置工作目录时沿用原行为：使用 exe 所在目录
    let working_dir = match explicit_workdir {
        Some(dir) => dir.to_path_buf(),
        None => exe_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."))
            .to_path_buf(),
    };
    cmd.current_dir(&working_dir);

    // 参数 = 专用参数框的内容（同样做引号感知的拆分）+「可执行文件」里附带的命令行参数
    let mut args: Vec<String> = parse_command_line(&task.arguments);
    args.extend(extra_args);
    let original_args = args.clone();
    let docker_run = prepare_docker_run(&task.id, args);
    let args = docker_run.map_or(original_args, |docker| docker.args);
    cmd.args(&args);

    // Windows 10+ 优先使用 ConPTY：子进程能看到真实控制台，
    // git/cargo/node 等程序会像真终端一样输出 ANSI 颜色；
    // 创建失败（旧系统）时回退到普通管道 + 隐藏窗口（子进程看不到 TTY，颜色由程序自行决定）
    #[cfg(target_os = "windows")]
    let pty = conpty::create_pty(120, 40);

    #[cfg(target_os = "windows")]
    if let Some(ref pty) = pty {
        // pty 输出为合并后的单一流（stdout+stderr），统一从输出管道读回（见下方）
        let make_stdio =
            |p: &conpty::Pty| std::process::Stdio::from(p.handle.try_clone().expect("pty 句柄"));
        cmd.stdin(make_stdio(pty));
        cmd.stdout(make_stdio(pty));
        cmd.stderr(make_stdio(pty));
    } else {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.creation_flags(0x08000000);
    }

    // Unix：让子进程成为独立进程组组长（pgid = 子进程 pid），
    // 停止时 kill -9 -{pid} 即可清理整棵进程树，对应 Windows 的 taskkill /T
    #[cfg(not(target_os = "windows"))]
    {
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.process_group(0);
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

    let log_dir = tm.data_dir.join("logs");
    std::fs::create_dir_all(&log_dir).ok();
    let log_path = log_dir.join(format!("{}.log", task.id));

    // ---- 读取子进程输出 ----
    // Windows 10+ 使用 ConPTY：stdout+stderr 合并为单条 pty 流（source 统一记为 stdout）；
    // 其余情况分别读取两条管道
    #[cfg(target_os = "windows")]
    {
        if let Some(pty) = pty {
            let file = std::fs::File::from(pty.output_read.try_clone().expect("pty 读端"));
            spawn_output_reader(
                app,
                &task.id,
                &log_path,
                "stdout",
                PtyReader {
                    inner: tokio::fs::File::from_std(file),
                    pty,
                },
            );
        } else {
            let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
            let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
            spawn_output_reader(app, &task.id, &log_path, "stdout", stdout);
            spawn_output_reader(app, &task.id, &log_path, "stderr", stderr);
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取 stderr")?;
        spawn_output_reader(app, &task.id, &log_path, "stdout", stdout);
        spawn_output_reader(app, &task.id, &log_path, "stderr", stderr);
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
    let task = {
        let tasks = state.tasks.lock().unwrap();
        tasks.get(&id).cloned()
    };
    let pid = {
        let states = state.states.lock().unwrap();
        states.get(&id).and_then(|s| s.pid)
    };

    if let Some(task) = task {
        let _ = stop_docker_container(&task);
    }
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
    let task = {
        let tasks = tm.tasks.lock().unwrap();
        tasks.get(&id).cloned().ok_or("任务不存在")?
    };

    let pid = {
        let states = tm.states.lock().unwrap();
        states.get(&id).and_then(|s| s.pid)
    };

    if let Err(e) = stop_docker_container(&task) {
        let _ = app.emit(
            "task-output",
            OutputEvent {
                task_id: id.clone(),
                source: "stderr".into(),
                text: format!("[Docker 停止失败] {}\n", e),
            },
        );
    }
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
        let task = {
            let tasks = tm.tasks.lock().unwrap();
            tasks.get(&id).cloned()
        };
        let pid = {
            let states = tm.states.lock().unwrap();
            states.get(&id).and_then(|s| s.pid)
        };
        if let Some(task) = task {
            if let Err(e) = stop_docker_container(&task) {
                let _ = app.emit(
                    "task-output",
                    OutputEvent {
                        task_id: id.clone(),
                        source: "stderr".into(),
                        text: format!("[Docker 停止失败] {}\n", e),
                    },
                );
            }
        }
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
    #[cfg(not(target_os = "windows"))]
    {
        let _ = value;
    }
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
// 保存运行快照并停止全部任务，下次启动时恢复；
fn perform_quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    if let Some(tm) = app.try_state::<Arc<TaskManager>>() {
        tm.sync_running_set();
        stop_all_tasks(app, &tm);
        // 无论何种模式，退出都清空所有任务日志，重启后不残留上一轮输出
        tm.clear_all_logs();
    }
    app.exit(0);
}

// 前端「完全退出」按钮：与托盘「退出应用」同流程，强制完整退出（不隐藏到托盘）
#[tauri::command]
fn quit_app(app: AppHandle) {
    perform_quit(&app)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 唯一实例：已存在一个活跃实例时，新实例会立即退出，
        // 插件在此回调中通知首个实例 —— 将现有窗口显示并聚焦到前台
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
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

            // 自动运行：逐个拉起开启「应用启动时自动运行」的任务。
            // setup 阶段不在 tokio 运行时上下文中，故显式调度到 Tauri 全局运行时；
            // 与手动启动共用原子启动槽位，已在运行的任务会被跳过
            let auto_ids = task_manager.auto_run_on_launch_ids();
            if !auto_ids.is_empty() {
                let handle = app.handle().clone();
                let tm = task_manager.clone();
                tauri::async_runtime::spawn(async move {
                    for id in auto_ids {
                        let Some(task) = tm.tasks.lock().unwrap().get(&id).cloned() else {
                            continue;
                        };
                        if !tm.try_begin_start(&id) {
                            continue;
                        }
                        let result = do_start_task(&handle, &tm, &task);
                        tm.end_start(&id);
                        if let Err(e) = result {
                            // 启动失败也写入该任务的输出区，界面上可见原因
                            let _ = handle.emit(
                                "task-output",
                                OutputEvent {
                                    task_id: id.clone(),
                                    source: "stderr".into(),
                                    text: format!("[启动失败] {}\n", e),
                                },
                            );
                        }
                    }
                });
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
            get_setting_silent_start,
            set_setting_silent_start,
            get_setting_keep_alive,
            set_setting_keep_alive,
            get_autostart,
            set_autostart,
            get_running_task_ids,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ==================== 测试 ====================

#[cfg(all(test, target_os = "windows"))]
#[test]
fn conpty_child_sees_tty_and_preserves_ansi() {
    use std::io::Read;

    let Some(pty) = conpty::create_pty(120, 40) else {
        eprintln!("ConPTY 不可用（Win8.1 及以下），跳过测试");
        return;
    };

    // 子进程：stdout 是真实控制台（TTY）时输出 ANSI 颜色，否则输出 PLAIN。
    // 挂在 ConPTY 上时 isTTY 应为 true，输出里必须带 ESC 转义字节。
    let script = "process.stdout.write(process.stdout.isTTY ? '\\x1b[31mRED\\x1b[0m' : 'PLAIN')";
    let mut cmd = std::process::Command::new("node");
    cmd.arg("-e").arg(script);
    cmd.stdin(std::process::Stdio::from(pty.handle.try_clone().unwrap()));
    cmd.stdout(std::process::Stdio::from(pty.handle.try_clone().unwrap()));
    cmd.stderr(std::process::Stdio::from(pty.handle.try_clone().unwrap()));
    let Ok(mut child) = cmd.spawn() else {
        eprintln!("node 不可用，跳过测试");
        return;
    };
    let mut out_file = std::fs::File::from(pty.output_read.try_clone().unwrap());
    let mut out = Vec::new();
    let _ = out_file.read_to_end(&mut out);
    let status = child.wait().unwrap();
    pty.close();

    assert!(status.success(), "node 退出异常: {}", status);
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.contains('\u{1b}'),
        "PTY 输出缺少 ANSI 转义字节: {:?}",
        text
    );
    assert!(text.contains("RED"), "PTY 输出缺少期望文本: {:?}", text);
}
