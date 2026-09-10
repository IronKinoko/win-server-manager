import type { TaskStatus } from '../types'
import { IconExpand, IconPlay, IconStop, IconTimer } from './icons'

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
  // 「应用启动时自动运行」的剩余秒数（0 表示没有倒计时）
  autoRunCountdown: number
  onCancelAutoRun: () => void
  onStart: () => void
  onStop: () => void
  onClearLog: () => void
  onToggleHeight: () => void
}

export default function ControlBar({
  status,
  pid,
  terminalHeight,
  autoRunCountdown,
  onCancelAutoRun,
  onStart,
  onStop,
  onClearLog,
  onToggleHeight,
}: ControlBarProps) {
  const si = statusInfo(status)
  // 倒计时期间按钮改为展示剩余秒数，点击即取消本次自动启动
  const countingDown = status !== 'running' && autoRunCountdown > 0
  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-line shrink-0">
      {status === 'running' ? (
        <button className="btn-stop flex items-center gap-1.5 leading-none" onClick={onStop}>
          <IconStop className="w-4 h-4 shrink-0" />
          停止 (PID {pid})
        </button>
      ) : countingDown ? (
        <button
          className="btn-countdown flex items-center gap-1.5 leading-none tabular-nums"
          title="点击取消本次自动启动"
          onClick={onCancelAutoRun}
        >
          <IconTimer className="w-4 h-4 shrink-0" />
          {autoRunCountdown}s 后自动启动（点击取消）
        </button>
      ) : (
        <button className="btn-start flex items-center gap-1.5 leading-none" onClick={onStart}>
          <IconPlay className="w-4 h-4 shrink-0" />
          启动
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
        className="btn-base px-2 flex items-center justify-center"
        onClick={onToggleHeight}
        title={`快速切换终端高度（当前 ${terminalHeight}px）`}
      >
        <IconExpand className="w-4 h-4" />
      </button>
    </div>
  )
}
