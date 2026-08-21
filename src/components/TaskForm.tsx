import type { Task } from '../types'
import './TaskForm.css'

interface TaskFormProps {
  form: Task
  dirty: boolean
  onChange: (patch: Partial<Task>) => void
  onSave: () => void
  onDelete: () => void
  onBrowseExe: () => void
  onBrowseDir: () => void
}

export default function TaskForm({ form, dirty, onChange, onSave, onDelete, onBrowseExe, onBrowseDir }: TaskFormProps) {
  return (
    <div className="form-panel">
      <div className="form-row">
        <label>任务名称</label>
        <input value={form.name} onChange={(e) => onChange({ name: e.target.value })} />
      </div>
      <div className="form-row">
        <label>可执行文件</label>
        <div className="path-input">
          <input
            value={form.exe_path}
            placeholder="D:\server\app.exe"
            onChange={(e) => onChange({ exe_path: e.target.value })}
          />
          <button className="btn" onClick={onBrowseExe}>
            浏览…
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>启动参数（每行可写多个参数，运行时自动拆分）</label>
        <textarea
          className="args-textarea"
          rows={3}
          value={form.arguments}
          placeholder={"--port 8080\n--config config.yaml"}
          onChange={(e) => onChange({ arguments: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label>工作目录</label>
        <div className="path-input">
          <input
            value={form.working_dir}
            placeholder="留空则使用 exe 所在目录"
            onChange={(e) => onChange({ working_dir: e.target.value })}
          />
          <button className="btn" onClick={onBrowseDir}>
            浏览…
          </button>
        </div>
      </div>
      <div className="form-row">
        <label>环境变量</label>
        <div className="env-list">
          {form.env_vars.map((ev, i) => (
            <div className="env-row" key={i}>
              <input
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
                className="btn btn-small"
                onClick={() =>
                  onChange({ env_vars: form.env_vars.filter((_, j) => j !== i) })
                }
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="btn btn-small"
            onClick={() =>
              onChange({ env_vars: [...form.env_vars, { key: '', value: '' }] })
            }
          >
            + 添加变量
          </button>
        </div>
      </div>
      <div className="form-row form-row-inline">
        <label>崩溃自动重启</label>
        <input
          type="checkbox"
          checked={form.auto_restart}
          onChange={(e) => onChange({ auto_restart: e.target.checked })}
        />
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={onSave} disabled={!dirty}>
          保存配置
        </button>
        <button className="btn btn-danger" onClick={onDelete}>
          删除任务
        </button>
      </div>
    </div>
  )
}
