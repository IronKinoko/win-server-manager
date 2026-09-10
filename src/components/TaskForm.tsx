import { useEffect, useMemo, useRef, useState } from 'react'
import type { Task } from '../types'
import AutoSizeTextarea from './AutoSizeTextarea'
import { compilePretty } from '../prettyOutput'

function buildPowerShell(form: Task): string {
  const exe = form.exe_path.trim().replace(/\s+/g, ' ')
  const argLines = form.arguments
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
  if (!exe && argLines.length === 0) return ''
  const head = exe || argLines[0]
  const headIsSpacedPath = head.includes(' ') && /[:\\]/.test(head.split(' ')[0])
  const headStr = headIsSpacedPath ? `"${head}"` : head
  const rest = exe ? argLines : argLines.slice(1)
  const firstLine = [headStr, rest[0]].filter(Boolean).join(' ')
  const commandLine = [firstLine, ...rest.slice(1)].join(' ')
  const dir = form.working_dir.trim()
  const parts: string[] = []
  if (dir) parts.push(`cd "${dir}" && .\\`)
  parts.push(`${commandLine}`)
  // 使用 PowerShell 单引号风格：\" 变为 "，其余双引号变为单引号
  return parts.join('').replace(/\\?"/g, (m) => (m === '\\"' ? '"' : "'"))
}
interface TaskFormProps {
  form: Task
  onChange: (patch: Partial<Task>) => void
  // 任意控件失焦时触发，由 App 决定是否保存
  onBlur: () => void
  onBrowseDir: () => void
}

export default function TaskForm({ form, onChange, onBlur, onBrowseDir }: TaskFormProps) {
  const prettyCode = form.pretty_code ?? ''

  // 代码有效性检查：非空且编译失败时在 textarea 下方提示
  const prettyError = useMemo(() => compilePretty(prettyCode).error, [prettyCode])

  // 美化输出：默认收起，只展开时才显示代码编辑区
  const [prettyExpanded, setPrettyExpanded] = useState(false)

  // 复制命令：成功后短暂显示「已复制」反馈
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  const handleCopy = () => {
    const text = buildPowerShell(form)
    if (!text) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }
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
            <button
              type="button"
              className="btn-base shrink-0"
              disabled={!buildPowerShell(form)}
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制命令'}
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
        <div className="flex flex-col gap-2">
          <label className="text-xs text-fg-muted">日志文件</label>
          <input
            className="field-input"
            value={form.log_file_path ?? ''}
            placeholder="D:\server\logs\app.log"
            onChange={(e) => onChange({ log_file_path: e.target.value })}
            onBlur={onBlur}
          />
          <span className="text-xs text-fg-muted">
            留空则只写入应用内部日志，相对路径按工作目录解析；保存时立即创建，每次启动清空重建并实时追加本次输出
          </span>
        </div>
        <div className="flex gap-3">
          <div className="flex flex-1 items-center justify-between rounded-md bg-input-bg/50 border border-line px-3 py-3">
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
          <div
            className="flex flex-1 items-center justify-between rounded-md bg-input-bg/50 border border-line px-3 py-3"
            title="应用启动后先倒计时 10 秒（按钮上展示剩余秒数，可随时取消），归零后自动运行"
          >
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
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-xs text-fg-muted">美化输出</label>
            <button
              type="button"
              className="text-xs text-fg-muted cursor-pointer transition-colors hover:text-fg"
              onClick={() => setPrettyExpanded((v) => !v)}
            >
              {prettyExpanded ? '收起' : '展开'}
            </button>
          </div>
          {/* 固定函数壳：首行/末行以固定文本渲染，textarea 只写函数体（见 prettyOutput.ts 的编译逻辑） */}
          {prettyExpanded ? (
            <div className="flex flex-col overflow-hidden rounded-md border border-line bg-input-bg focus-within:border-accent">
              <div className="select-none px-3 pt-2 font-mono text-xs leading-relaxed text-fg-muted">
                {'function pretty( lines: string[], { chalk } ): string[] {'}
              </div>
              <AutoSizeTextarea
                className="w-full min-h-14 resize-none bg-transparent px-3 py-2 font-mono text-sm leading-relaxed text-fg outline-none"
                value={prettyCode}
                placeholder="return lines.map((line) => chalk.green(line))"
                onChange={(e) => onChange({ pretty_code: e.target.value })}
                onBlur={onBlur}
              />
              <div className="select-none px-3 pb-2 font-mono text-xs leading-relaxed text-fg-muted">
                {'}'}
              </div>
            </div>
          ) : null}
          <span className="text-xs text-fg-muted">
            外层函数壳已固定，这里只写函数体：lines 为本次新增的输出行，chalk 用于上色，return
            美化后的行（可返回不同行数）
          </span>
          {prettyCode.trim() && prettyError ? (
            <span className="text-xs text-danger">美化代码无效：{prettyError}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
