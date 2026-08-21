import type { TaskStatus } from '../types'
import './ControlBar.css'

function statusInfo(s: TaskStatus) {
  switch (s) {
    case 'running':
      return { label: '运行中', cls: 'st-running' }
    case 'crashed':
      return { label: '已崩溃', cls: 'st-crashed' }
    default:
      return { label: '已停止', cls: 'st-stopped' }
  }
}

interface ControlBarProps {
  status: TaskStatus
  pid: number | null
  onStart: () => void
  onStop: () => void
  onClearLog: () => void
}

export default function ControlBar({ status, pid, onStart, onStop, onClearLog }: ControlBarProps) {
  const si = statusInfo(status)
  return (
    <div className="control-bar">
      {status === 'running' ? (
        <button className="btn btn-stop" onClick={onStop}>
          ■ 停止 (PID {pid})
        </button>
      ) : (
        <button className="btn btn-start" onClick={onStart}>
          ▶ 启动
        </button>
      )}
      <span className={`status-badge ${si.cls}`}>{si.label}</span>
      <div className="spacer" />
      <button className="btn" onClick={onClearLog}>
        清空输出
      </button>
    </div>
  )
}
