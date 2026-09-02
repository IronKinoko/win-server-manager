import { useEffect, useMemo } from 'react'
import type { Task } from '../types'
import AutoSizeTextarea from './AutoSizeTextarea'
import { compilePretty, setPrettyCode } from '../prettyOutput'

interface TaskFormProps {
  form: Task
  onChange: (patch: Partial<Task>) => void
  // 任意控件失焦时触发，由 App 决定是否保存
  onBlur: () => void
  onBrowseExe: () => void
  onBrowseDir: () => void
}

export default function TaskForm({
  form,
  onChange,
  onBlur,
  onBrowseExe,
  onBrowseDir,
}: TaskFormProps) {
  const prettyCode = form.pretty_code ?? ''

  // 把当前任务的美化代码同步给 OutputPanel（模块级 store，见 prettyOutput.ts），
  // 依赖 form 值而非 onChange，因此切换任务选中时也会自动更新
  useEffect(() => {
    setPrettyCode(prettyCode)
  }, [prettyCode])

  // 代码有效性检查：非空且编译失败时在 textarea 下方提示
  const prettyError = useMemo(() => compilePretty(prettyCode).error, [prettyCode])
  return (
    <div className="flex flex-col flex-1 min-h-0 border-b border-line">
      {/* Header：可随时编辑的任务名称（失焦即自动保存，不再有手动保存按钮） */}
      <div className="shrink-0 flex items-center gap-3 bg-panel border-b border-line px-4 py-3">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-base font-medium text-fg outline-none transition-colors hover:border-line focus:border-accent placeholder:text-fg-muted/60"
          value={form.name}
          placeholder="输入任务名称…"
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={onBlur}
        />
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
              onBlur={onBlur}
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
              onBlur={onBlur}
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
            className="field-input font-mono resize-none leading-relaxed min-h-21 py-2"
            value={form.arguments}
            placeholder={'--port 8080\n--config config.yaml'}
            onChange={(e) => onChange({ arguments: e.target.value })}
            onBlur={onBlur}
          />
        </div>
        <div className="flex items-center justify-between rounded-md bg-input-bg/50 border border-line px-3 py-3">
          <span className="text-sm text-fg">崩溃自动重启</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={form.auto_restart}
              onChange={(e) => onChange({ auto_restart: e.target.checked })}
              onBlur={onBlur}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="flex items-center justify-between rounded-md bg-input-bg/50 border border-line px-3 py-3">
          <span className="text-sm text-fg">应用启动时自动运行</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={form.auto_run_on_launch}
              onChange={(e) => onChange({ auto_run_on_launch: e.target.checked })}
              onBlur={onBlur}
            />
            <span className="switch-slider" />
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">美化输出</label>
          <AutoSizeTextarea
            className="field-input font-mono resize-none leading-relaxed min-h-14 py-2"
            value={prettyCode}
            placeholder="function pretty( lines: string[], { chalk } ) : string[]"
            onChange={(e) => onChange({ pretty_code: e.target.value })}
            onBlur={onBlur}
          />
          <span className="text-xs text-fg-muted">
            写一段 JS：每次输出增量追加时调用 pretty(新增行, {'{ chalk }'}
            )，返回美化后的行（可返回不同行数，可用 chalk 上色）
          </span>
          {prettyCode.trim() && prettyError ? (
            <span className="text-xs text-danger">美化代码无效：{prettyError}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
