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
import SettingsModal from './components/SettingsModal'
import './App.css'

const MAX_OUTPUT_LINES = 500
const ansi = new AnsiUp()
ansi.escape_html = true

function App() {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, string[]>>({})
  const [form, setForm] = useState<Task | null>(null)
  const [dirty, setDirty] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [autoStart, setAutoStart] = useState(() => localStorage.getItem('autostart') === 'true')

  // 终端区域高度（所有任务通用，持久化到 localStorage）
  const [terminalHeight, setTerminalHeight] = useState<number>(() => {
    const saved = localStorage.getItem('terminal-height')
    return saved ? parseInt(saved, 10) : 250
  })
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null)

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
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
  }, [terminalHeight])

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
    refreshTasks()
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const track = (fn: () => void) => {
      if (cancelled) { fn(); return }
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

  const selectTask = async (id: string) => {
    setSelectedId(id)
    const t = tasks.find((x) => x.task.id === id)
    if (t) {
      setForm({ ...t.task, env_vars: t.task.env_vars.map((e) => ({ ...e })) })
      const log = await invoke<string>('get_task_log', { id })
      setOutputs((prev) => ({
        ...prev,
        [id]: log ? log.split('\n').slice(-MAX_OUTPUT_LINES) : [],
      }))
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
    await invoke('start_task', { id: selected.task.id })
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
    <div className="app">
      <Sidebar
        tasks={tasks}
        selectedId={selectedId}
        onSelect={selectTask}
        onAdd={handleAdd}
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="main">
        {!form || !selected ? (
          <div className="placeholder">
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

      <SettingsModal
        show={showSettings}
        onClose={() => setShowSettings(false)}
        autoStart={autoStart}
        onAutoStartChange={(v) => {
          setAutoStart(v)
          localStorage.setItem('autostart', String(v))
        }}
      />
    </div>
  )
}

export default App
