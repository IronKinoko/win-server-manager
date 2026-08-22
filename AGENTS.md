# AI Agent 指南

## 项目

`win-server-manager` 是一个 Windows 桌面任务/进程管理器，使用 Tauri 2、React 19、TypeScript、Vite、Tailwind CSS 和 Rust 构建。界面文本主要使用中文。

请阅读 [README.md](README.md)，了解仓库当前的基础配置说明。

## 命令

- 安装依赖：`pnpm install`
- 启动前端开发服务器：`pnpm dev`
- 前端类型检查和生产构建：`pnpm build`
- 启动桌面应用：`pnpm tauri dev`
- 构建桌面安装包：`pnpm release`
- Rust 检查：`cargo check --manifest-path src-tauri/Cargo.toml`

- 代码检查：`pnpm lint`（ESLint）、`pnpm format` / `pnpm format:check`（Prettier）

已配置提交前检查（husky pre-commit）：先 `tsc --noEmit`，再对暂存文件跑 lint-staged —— TS/TSX 走 `eslint --fix` + `prettier --write`，CSS 走 `prettier --write`，Rust 源文件走 `rustfmt --edition 2021`。Prettier 风格见 [.prettierrc.json](.prettierrc.json)（无分号、单引号）。修改前端后运行 `pnpm build`；修改 Rust 或 Tauri 配置后还要运行 Rust 检查。Tauri 开发要求 Vite 使用端口 `1420`，并在 [vite.config.ts](vite.config.ts) 中启用了严格端口模式。

## 架构

- `src/App.tsx` 负责主任务列表、任务表单、生命周期操作、日志显示和 Tauri 事件订阅。
- `src/types.ts` 定义任务、状态以及输出/状态事件的 TypeScript 契约。
- `src/App.css` 包含当前界面样式。
- `src-tauri/src/lib.rs` 负责任务持久化、进程启动/停止、Windows 进程树清理、输出解码、日志文件、Tauri 命令和事件发送。
- `src-tauri/src/main.rs` 是精简的 Windows 入口文件；必须保留 `windows_subsystem` 属性。
- `src-tauri/capabilities/default.json` 控制主窗口的 Tauri/插件权限。
- `src-tauri/tauri.conf.json` 连接 Vite 构建结果和 Tauri 应用。

保持 IPC 契约同步：每次修改 Rust 命令或事件载荷，都要同步更新对应的 TypeScript 类型和调用方。命令使用 Tauri `invoke`，后端事件使用 `listen`，不要另加一套通信方式。

## 约定与注意事项

- 模型思考的时候尽量精简，不要在思考里输出过多的代码，并且不要循环输出相同的内容，如果思考过多请考虑拆分成多个子任务分别完成。
- 除非任务明确要求修改产品语言，否则保持现有 React/TypeScript 风格和中文界面文案。
- 修改应限定在负责该行为的层中。没有明确的契约变更时，不要把进程管理移到前端，也不要把界面状态移到 Rust。
- 任务数据由 Rust 持久化到应用数据目录中的 `tasks.json`；每个任务的日志存放在 `logs/` 下。运行时不要假设数据位于仓库目录中。
- Windows 子进程输出可能不是 UTF-8；修改输出处理时要保留现有的 UTF-8/GBK 解码行为。
- 保持输出的换行边界和 ANSI 转义序列处理不变。修改日志拆分、渲染或前缀可能同时影响换行显示和颜色解析。
- Rust 命令的返回值通常是 `TaskInfo`，不是 `Task`；在 React 中解构前必须确认实际载荷类型。
- Windows 进程命令使用隐藏控制台创建标志，并通过 `taskkill` 清理进程树；平台相关代码应继续放在现有条件编译块中。
- 不要手动修改 `src-tauri/gen` 下的生成文件或 `src-tauri/target` 下的构建产物。
- Tauri capability 修改会影响本地系统访问。新增插件命令时，只授予必要权限，并同步更新 `src-tauri/capabilities/default.json`。
- 在 Windows 上，如果 `pnpm tauri dev` 无法绑定端口，先检查端口 `1420` 是否已被其他进程占用，再考虑修改配置端口。

## 修改与验证流程

1. 定位负责该行为的前端或 Rust 文件，并检查相邻的类型定义和调用方。
2. 在保持现有 IPC 与持久化契约的前提下，进行最小范围修改。
3. 先运行可用的最窄检查，再运行 `pnpm build`；修改 Rust/Tauri 文件时运行 `cargo check --manifest-path src-tauri/Cargo.toml`。
4. 修改进程生命周期或输出处理后，使用一个小型 Windows 测试进程手动验证添加、编辑、启动、停止、删除、stdout/stderr、非 UTF-8 输出和日志重新加载。
5. 如果验证因缺少 Windows/Tauri 前置环境而受阻，应明确报告，不要静默跳过。
