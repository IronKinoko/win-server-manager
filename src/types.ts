export interface EnvVar {
  key: string
  value: string
}

export interface Task {
  id: string
  name: string
  exe_path: string
  arguments: string
  working_dir: string
  env_vars: EnvVar[]
  auto_restart: boolean
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
