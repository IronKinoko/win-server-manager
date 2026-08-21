# win-server-manager

Windows 桌面任务/进程管理器。基于 Tauri 2 + React 19 + TypeScript + Vite + Rust，界面为中文。

## 功能

- **任务管理**：添加、编辑、删除任务，可配置可执行文件路径（支持直接写裸命令名或完整命令行）、参数（引号感知解析）、工作目录、环境变量和自动重启开关；侧栏服务列表按名称首字母排序。
- **启动与停止**：以隐藏控制台窗口方式启动子进程；停止时强制清理整棵进程树（`taskkill /T /F`，同步等待并校验存活，防止退出时残留孤儿进程占用端口）；同名进程先清理再启动；重复启动原子去重。
- **实时终端输出**：stdout/stderr 实时显示，stderr 红色高亮；ANSI 转义序列颜色解析；换行边界安全拆分；非 UTF-8（GBK）输出安全解码，不会崩溃或乱码中断。
- **日志策略**：
  - 进入**已停止**的任务：显示空终端，同时清掉磁盘上残留的日志；
  - **运行中**的任务：显示本次会话的完整输出（实时追加）；
  - **异常退出（crashed）**的任务：保留现场输出便于排查；
  - 应用正常退出：**清空全部任务日志**，下次会话干净起步。
- **系统托盘驻留**：默认关闭主窗口仅隐藏到系统托盘，任务继续在后台运行；右键托盘图标可"打开"/"退出应用"。
- **设置**（设置面板，持久化到 `settings.json`）：
  - **开机自启**：写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（值为带引号的当前 exe 路径）。注意开发模式（`pnpm tauri dev`）下会注册调试 exe，测试完记得关掉。
  - **允许后台继续运行**：开启（默认）= 关闭主窗口隐藏到托盘；关闭 = 点 × 直接退出，走与托盘"退出应用"相同的流程。旧版配置文件无此字段时保持隐藏到托盘。
  - **静默启动**：启动时不显示主窗口，仅在托盘驻留。
  - **自动恢复任务**：退出前把运行中的任务记入快照（`running_tasks.json`）并停止它们，下次启动时自动重新拉起；关闭时退出不停止进程（任务留在后台运行），也不做恢复。

## 数据存储

所有数据位于 `%APPDATA%\com.winservermanager.app\`：

| 文件                 | 内容                                 |
| -------------------- | ------------------------------------ |
| `tasks.json`         | 任务定义列表                         |
| `settings.json`      | 设置项（自动恢复/静默启动/后台驻留） |
| `running_tasks.json` | 退出时的运行快照（供自动恢复）       |
| `logs/<task_id>.log` | 每个任务的原始输出日志               |

## 开发与构建

| 命令                                               | 说明                               |
| -------------------------------------------------- | ---------------------------------- |
| `pnpm install`                                     | 安装前端依赖                       |
| `pnpm tauri dev`                                   | 启动开发环境（Vite 固定端口 1420） |
| `pnpm build`                                       | 前端类型检查 + 生产构建            |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Rust 侧编译检查                    |
| `pnpm release`                                     | `tauri build`，生成安装包                |
| `pnpm lint`                                        | ESLint 代码检查                          |
| `pnpm format` / `pnpm format:check`                | Prettier 格式化 / 格式校验               |

已配置提交前检查（husky + lint-staged）：提交时自动跑 `tsc --noEmit`，并对暂存文件执行 `eslint --fix` + `prettier --write`（TS/TSX）、`prettier --write`（CSS）、`rustfmt`（Rust）。Prettier 风格为无分号 + 单引号，见 [.prettierrc.json](.prettierrc.json)。

修改前端后跑 `pnpm build`；修改 Rust/Tauri 配置后再跑 cargo check。AI 协作约定见 [AGENTS.md](AGENTS.md)。

## 推荐 IDE 配置

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
