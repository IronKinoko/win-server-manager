import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { AnsiUp } from 'ansi_up'
import type { Task, TaskInfo, OutputEvent, StatusEvent } from './types'
import Sidebar from './components/Sidebar'
import TaskForm from './components/TaskForm'
import ControlBar from './components/ControlBar'
import OutputPanel from './components/OutputPanel'
import SettingsModal, { type SettingsModalHandle } from './components/SettingsModal'

const MAX_OUTPUT_LINES = 500
const ansi = new AnsiUp()
ansi.escape_html = true

// 覆盖默认配色为 Windows Console 深色背景下的标准值
type AnsiColor = { rgb: number[]; class_name: string }
const ansiColors = ansi as unknown as {
  ansi_colors: [AnsiColor[], AnsiColor[]]
  palette_256: AnsiColor[]
}
ansiColors.ansi_colors = [
  // Normal (30-37)
  [
    { rgb: [0, 0, 0], class_name: 'ansi-black' },
    { rgb: [205, 49, 49], class_name: 'ansi-red' },
    { rgb: [13, 188, 121], class_name: 'ansi-green' },
    { rgb: [229, 231, 16], class_name: 'ansi-yellow' },
    { rgb: [51, 153, 255], class_name: 'ansi-blue' },
    { rgb: [188, 63, 188], class_name: 'ansi-magenta' },
    { rgb: [17, 168, 205], class_name: 'ansi-cyan' },
    { rgb: [204, 204, 204], class_name: 'ansi-white' },
  ],
  // Bright (90-97)
  [
    { rgb: [118, 118, 118], class_name: 'ansi-bright-black' },
    { rgb: [231, 72, 86], class_name: 'ansi-bright-red' },
    { rgb: [49, 221, 185], class_name: 'ansi-bright-green' },
    { rgb: [240, 230, 140], class_name: 'ansi-bright-yellow' },
    { rgb: [74, 166, 255], class_name: 'ansi-bright-blue' },
    { rgb: [234, 92, 236], class_name: 'ansi-bright-magenta' },
    { rgb: [53, 196, 231], class_name: 'ansi-bright-cyan' },
    { rgb: [255, 255, 255], class_name: 'ansi-bright-white' },
  ],
]
// 同步更新 256 色板的前 16 项
const palette: AnsiColor[] = ansiColors.palette_256
for (let i = 0; i < 16 && i < palette.length; i++) {
  const src = i < 8 ? ansiColors.ansi_colors[0][i] : ansiColors.ansi_colors[1][i - 8]
  palette[i] = { ...palette[i], rgb: [...src.rgb], class_name: src.class_name }
}

function App() {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, string[]>>({})
  const [form, setForm] = useState<Task | null>(null)
  const [dirty, setDirty] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<SettingsModalHandle>(null)

  // 终端区域高度（所有任务通用，持久化到 localStorage）
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const saved = localStorage.getItem('terminal-height')
    return saved ? parseInt(saved, 10) : 250
  })
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragState.current = { startY: e.clientY, startHeight: terminalHeight }
      const onMove = (ev: MouseEvent) => {
        const ds = dragState.current
        if (!ds) return
        const delta = ds.startY - ev.clientY
        const newHeight = Math.min(600, Math.max(100, ds.startHeight + delta))
        setTerminalHeight(newHeight)
      }
      const onUp = () => {
        dragState.current = null
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setTerminalHeight((h) => {
          localStorage.setItem('terminal-height', String(h))
          return h
        })
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    },
    [terminalHeight],
  )

  const selected = tasks.find((t) => t.task.id === selectedId) ?? null

  const outputHtml = useMemo(() => {
    if (!selected) return ''
    const lines = outputs[selected.task.id] ?? []
    if (lines.length === 0) return ''
    return lines
      .map((l) => {
        const line = l.replace(/[\r\n]+$/, '')
        const m = line.match(/^\[(stdout|stderr)\] (.*)$/)
        const src = m?.[1] ?? 'stdout'
        const text = m?.[2] ?? line
        return `<span class="out-${src}">${ansi.ansi_to_html(text)}</span>`
      })
      .join('')
  }, [outputs, selected])

  const refreshTasks = useCallback(async () => {
    const list = await invoke<TaskInfo[]>('get_tasks')
    setTasks(list)
    return list
  }, [])

  // 加载任务列表 + 监听后端事件
  useEffect(() => {
    let cancelled = false
    refreshTasks().then(async (list) => {
      // 自动恢复：若设置开启，重启上次退出前正在运行中的任务
      // （StrictMode 下 effect 可能执行两次，cancelled 保证只有一条恢复链路生效）
      try {
        if (cancelled) return
        const autoRestore = await invoke<boolean>('get_setting_auto_restore')
        if (!autoRestore) return
        const ids = await invoke<string[]>('get_running_task_ids')
        for (const id of ids) {
          if (cancelled) break
          const t = list.find((x) => x.task.id === id)
          if (t && t.status !== 'running') {
            await invoke('start_task', { id }).catch(() => {})
          }
        }
      } catch {
        // 自动恢复失败不影响正常使用
      }
    })
    const unlisteners: Array<() => void> = []
    const track = (fn: () => void) => {
      if (cancelled) {
        fn()
        return
      }
      unlisteners.push(fn)
    }

    listen<OutputEvent>('task-output', (event) => {
      if (cancelled) return
      const { task_id, source, text } = event.payload
      setOutputs((prev) => {
        const lines = [...(prev[task_id] ?? []), `[${source}] ${text}`]
        return { ...prev, [task_id]: lines.slice(-MAX_OUTPUT_LINES) }
      })
    }).then(track)

    listen<StatusEvent>('task-status', () => {
      if (cancelled) return
      refreshTasks()
    }).then(track)

    listen<{ task_id: string }>('task-output-clear', (event) => {
      if (cancelled) return
      const { task_id } = event.payload
      setOutputs((prev) => ({ ...prev, [task_id]: [] }))
    }).then(track)

    return () => {
      cancelled = true
      unlisteners.forEach((fn) => fn())
    }
  }, [refreshTasks])

  // 输出区自动滚动到底部
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [outputs, selectedId])

  // Ctrl/Cmd + A 仅全选终端输出区内容，避免选中其它 UI
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isSelectAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a'
      if (!isSelectAll) return
      const outputEl = outputRef.current
      if (!outputEl) return

      const active = document.activeElement
      const selection = window.getSelection()
      const anchorInOutput = !!selection?.anchorNode && outputEl.contains(selection.anchorNode)
      const focusInOutput = active === outputEl || (!!active && outputEl.contains(active))

      if (!anchorInOutput && !focusInOutput) return

      event.preventDefault()
      const range = document.createRange()
      range.selectNodeContents(outputEl)
      selection?.removeAllRanges()
      selection?.addRange(range)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const selectTask = async (id: string) => {
    // 切走已停止的任务时顺手清掉它的日志（内存 + 磁盘）
    if (selectedId && selectedId !== id) {
      const leaving = tasks.find((x) => x.task.id === selectedId)
      if (leaving?.status === 'stopped') {
        const lid = selectedId
        setOutputs((prev) => ({ ...prev, [lid]: [] }))
        invoke('clear_task_log', { id: lid }).catch(() => {})
      }
    }
    setSelectedId(id)
    const t = tasks.find((x) => x.task.id === id)
    if (t) {
      setForm({ ...t.task, env_vars: t.task.env_vars.map((e) => ({ ...e })) })
      if (t.status === 'stopped') {
        // 进入已停止的任务不回显历史：直接空终端，并清掉磁盘上残留的日志。
        // 以「进入时」的状态为准，避免离开时刻状态未及时刷新导致旧日志复活
        setOutputs((prev) => ({ ...prev, [id]: [] }))
        invoke('clear_task_log', { id }).catch(() => {})
      } else {
        const log = await invoke<string>('get_task_log', { id })
        const rawLines = log ? log.split('\n').map((l) => l.replace(/\r$/, '')) : []
        // 日志文件以换行结尾，split 会多出一个尾部空串，去掉以免每次进入多出空白行
        const lines =
          rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
            ? rawLines.slice(0, -1)
            : rawLines
        setOutputs((prev) => ({
          ...prev,
          [id]: lines.slice(-MAX_OUTPUT_LINES),
        }))
      }
    }
    setDirty(false)
  }

  const updateForm = (patch: Partial<Task>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setDirty(true)
  }

  const handleAdd = async () => {
    const task: Task = {
      id: '',
      name: `任务 ${tasks.length + 1}`,
      exe_path: '',
      arguments: '',
      working_dir: '',
      env_vars: [],
      auto_restart: false,
    }
    const created = await invoke<TaskInfo>('add_task', { task })
    await refreshTasks()
    setSelectedId(created.task.id)
    setForm({ ...created.task, env_vars: created.task.env_vars.map((e) => ({ ...e })) })
    setDirty(false)
  }

  const handleSave = async () => {
    if (!form) return
    const updated = await invoke<TaskInfo>('update_task', { task: form })
    await refreshTasks()
    setForm({ ...updated.task, env_vars: updated.task.env_vars.map((e) => ({ ...e })) })
    setDirty(false)
  }

  const handleDelete = async () => {
    if (!selected) return
    if (!window.confirm(`确定删除任务「${selected.task.name}」吗？`)) return
    if (selected.status !== 'stopped') {
      await invoke('stop_task', { id: selected.task.id })
    }
    await invoke('delete_task', { id: selected.task.id })
    setSelectedId(null)
    setForm(null)
    await refreshTasks()
  }

  const handleStart = async () => {
    if (!selected) return
    if (dirty && form) await handleSave()
    const id = selected.task.id
    try {
      await invoke('start_task', { id })
    } catch (e) {
      // 启动失败（如可执行文件不存在）：把后端返回的错误显示到该任务的输出区
      setOutputs((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), `[错误] ${String(e)}`].slice(-MAX_OUTPUT_LINES),
      }))
    }
  }

  const handleStop = async () => {
    if (!selected) return
    await invoke('stop_task', { id: selected.task.id })
  }

  const handleClearLog = async () => {
    if (!selected) return
    await invoke('clear_task_log', { id: selected.task.id })
    setOutputs((prev) => ({ ...prev, [selected.task.id]: [] }))
  }

  const handleBrowseExe = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd'] }],
    })
    if (typeof path === 'string') updateForm({ exe_path: path })
  }

  const handleBrowseDir = async () => {
    const path = await open({ multiple: false, directory: true })
    if (typeof path === 'string') updateForm({ working_dir: path })
  }

  return (
    <div className="flex h-screen bg-surface text-fg font-sans select-none">
      <Sidebar
        tasks={tasks}
        selectedId={selectedId}
        onSelect={selectTask}
        onAdd={handleAdd}
        onOpenSettings={() => settingsRef.current?.open()}
      />

      <main className="flex flex-col flex-1 min-w-0">
        {!form || !selected ? (
          <div className="flex flex-1 items-center justify-center text-fg-muted">
            <p>从左侧选择任务，或点击「添加任务」创建新任务</p>
          </div>
        ) : (
          <>
            <TaskForm
              form={form}
              dirty={dirty}
              onChange={updateForm}
              onSave={handleSave}
              onDelete={handleDelete}
              onBrowseExe={handleBrowseExe}
              onBrowseDir={handleBrowseDir}
            />
            <ControlBar
              status={selected.status}
              pid={selected.pid}
              onStart={handleStart}
              onStop={handleStop}
              onClearLog={handleClearLog}
            />
            <OutputPanel
              html={outputHtml}
              height={terminalHeight}
              outputRef={outputRef}
              onMouseDownResize={handleResizeStart}
            />
          </>
        )}
      </main>

      <SettingsModal ref={settingsRef} />
    </div>
  )
}

export default App
