import type { TaskStatus } from '../types'

function statusInfo(s: TaskStatus) {
  switch (s) {
    case 'running':
      return { label: '运行中', cls: 'text-success border-success/40' }
    case 'crashed':
      return { label: '已崩溃', cls: 'text-danger border-danger/40' }
    default:
      return { label: '已停止', cls: 'text-idle border-line' }
  }
}

interface ControlBarProps {
  status: TaskStatus
  pid: number | null
  terminalHeight: number
  onStart: () => void
  onStop: () => void
  onClearLog: () => void
  onToggleHeight: () => void
}

export default function ControlBar({
  status,
  pid,
  terminalHeight,
  onStart,
  onStop,
  onClearLog,
  onToggleHeight,
}: ControlBarProps) {
  const si = statusInfo(status)
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-line shrink-0">
      {status === 'running' ? (
        <button className="btn-stop" onClick={onStop}>
          ■ 停止 (PID {pid})
        </button>
      ) : (
        <button className="btn-start" onClick={onStart}>
          ▶ 启动
        </button>
      )}
      <span className={`text-xs px-3 py-1 rounded-full bg-input-bg border ${si.cls}`}>
        {si.label}
      </span>
      <div className="flex-1" />
      <button className="btn-base" onClick={onClearLog}>
        清空输出
      </button>
      <button
        className="btn-base px-2"
        onClick={onToggleHeight}
        title={`快速切换终端高度（当前 ${terminalHeight}px）`}
      >
        ⇕
      </button>
    </div>
  )
}
