import type { Task } from '../types'

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
  return (
    <div
      key={form.id}
      className="p-4 border-b border-line flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto"
    >
      <div className="flex flex-col gap-2">
        <label className="text-xs text-fg-muted">任务名称</label>
        <input
          className="field-input"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
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
        <textarea
          rows={3}
          className="field-input font-mono resize-y min-h-[60px] leading-relaxed"
          value={form.arguments}
          placeholder={'--port 8080\n--config config.yaml'}
          onChange={(e) => onChange({ arguments: e.target.value })}
        />
      </div>
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
      <div className="flex gap-3 mt-1">
        <button className="btn-primary" onClick={onSave} disabled={!dirty}>
          保存配置
        </button>
        <button className="btn-danger" onClick={onDelete}>
          删除任务
        </button>
      </div>
    </div>
  )
}
