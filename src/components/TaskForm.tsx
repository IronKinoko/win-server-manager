import { useEffect, useRef, useState } from 'react'
import type { Task } from '../types'
import AutoSizeTextarea from './AutoSizeTextarea'

interface TaskFormProps {
  form: Task
  dirty: boolean
  onChange: (patch: Partial<Task>) => void
  onSave: () => void
  onDelete: () => void
  onBrowseExe: () => void
  onBrowseDir: () => void
}

export default function TaskForm({
  form,
  dirty,
  onChange,
  onSave,
  onDelete,
  onBrowseExe,
  onBrowseDir,
}: TaskFormProps) {
  // 删除二次确认：第一次点击后进入确认态，3 秒内再次点击才真正删除
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const confirmTimer = useRef<number | undefined>(undefined)

  // 组件按 form.id 重新挂载（见 App.tsx），切换任务时确认态自然重置；卸载前清理定时器
  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  const handleDeleteClick = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirmingDelete(false), 3000)
      return
    }
    window.clearTimeout(confirmTimer.current)
    setConfirmingDelete(false)
    onDelete()
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 border-b border-line">
      {/* Header：左侧可随时编辑的任务名称，右侧操作按钮 */}
      <div className="shrink-0 flex items-center gap-3 bg-panel border-b border-line px-4 py-3">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-base font-medium text-fg outline-none transition-colors hover:border-line focus:border-accent placeholder:text-fg-muted/60"
          value={form.name}
          placeholder="输入任务名称…"
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <div className="flex shrink-0 gap-2">
          <button className="btn-primary" onClick={onSave} disabled={!dirty}>
            保存
          </button>
          <button
            className={`btn-danger ${confirmingDelete ? 'bg-danger text-white' : ''}`}
            onClick={handleDeleteClick}
          >
            {confirmingDelete ? '确认删除？' : '删除'}
          </button>
        </div>
      </div>

      {/* Body：其余配置项 */}
      <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">工作目录</label>
          <div className="flex gap-2">
            <input
              className="field-input flex-1"
              value={form.working_dir}
              placeholder="留空则使用 exe 所在目录"
              onChange={(e) => onChange({ working_dir: e.target.value })}
            />
            <button className="btn-base shrink-0" onClick={onBrowseDir}>
              浏览…
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">可执行文件</label>
          <div className="flex gap-2">
            <input
              className="field-input flex-1"
              value={form.exe_path}
              placeholder="D:\server\app.exe"
              onChange={(e) => onChange({ exe_path: e.target.value })}
            />
            <button className="btn-base shrink-0" onClick={onBrowseExe}>
              浏览…
            </button>
          </div>
          <span className="text-xs text-fg-muted">
            支持完整命令（如 node D:\AI\server.js），仅写名称时自动搜索 PATH
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">
            启动参数（每行可写多个参数，运行时自动拆分）
          </label>
          <AutoSizeTextarea
            className="field-input font-mono resize-none leading-relaxed min-h-21"
            value={form.arguments}
            placeholder={'--port 8080\n--config config.yaml'}
            onChange={(e) => onChange({ arguments: e.target.value })}
          />
        </div>
        <div className="flex items-center justify-between rounded-md bg-input-bg/50 border border-line px-3 py-3">
          <span className="text-sm text-fg">崩溃自动重启</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={form.auto_restart}
              onChange={(e) => onChange({ auto_restart: e.target.checked })}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">环境变量</label>
          <div className="flex flex-col gap-2">
            {form.env_vars.map((ev, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="field-input basis-2/5 grow-0"
                  placeholder="KEY"
                  value={ev.key}
                  onChange={(e) => {
                    const env_vars = form.env_vars.map((x, j) =>
                      j === i ? { ...x, key: e.target.value } : x,
                    )
                    onChange({ env_vars })
                  }}
                />
                <input
                  className="field-input flex-1"
                  placeholder="VALUE"
                  value={ev.value}
                  onChange={(e) => {
                    const env_vars = form.env_vars.map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    )
                    onChange({ env_vars })
                  }}
                />
                <button
                  className="btn-base px-2 py-1 text-xs"
                  onClick={() => onChange({ env_vars: form.env_vars.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              className="btn-base px-2 py-1 text-xs self-start"
              onClick={() => onChange({ env_vars: [...form.env_vars, { key: '', value: '' }] })}
            >
              + 添加变量
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
