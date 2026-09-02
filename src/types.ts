export interface Task {
  id: string
  name: string
  exe_path: string
  arguments: string
  working_dir: string
  auto_restart: boolean
  // 应用启动时自动运行该任务
  auto_run_on_launch: boolean
  // 自定义美化输出代码（JS：function pretty(lines: string[]): string[]），随任务持久化
  pretty_code?: string
}

export type TaskStatus = 'stopped' | 'running' | 'crashed'

export interface TaskInfo {
  task: Task
  status: TaskStatus
  pid: number | null
}

export interface OutputEvent {
  task_id: string
  source: 'stdout' | 'stderr'
  text: string
}

export interface StatusEvent {
  task_id: string
  status: TaskStatus
}
