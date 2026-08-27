import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import type { Task, TaskInfo, OutputEvent, StatusEvent } from './types'
import Sidebar from './components/Sidebar'
import TaskForm from './components/TaskForm'
import ControlBar from './components/ControlBar'
import OutputPanel, { type OutputLine } from './components/OutputPanel'
import SettingsModal, { type SettingsModalHandle } from './components/SettingsModal'

// 稳定引用：避免每次渲染给 OutputPanel 传新的空数组，触发无谓的终端重置
const EMPTY_OUTPUT_LINES: OutputLine[] = []

function App() {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outputs, setOutputs] = useState<Record<string, OutputLine[]>>({})
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

  const refreshTasks = useCallback(async () => {
    const list = await invoke<TaskInfo[]>('get_tasks')
    setTasks(list)
    return list
  }, [])

  // 加载任务列表 + 监听后端事件
  useEffect(() => {
    let cancelled = false
    refreshTasks()
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
      // 后端按 \n 切块发送且保留行尾换行；渲染层再用 \n 把各行 join 起来。
      // 若原样存入，每条都带着自身尾部的 \n，join 后相邻两条之间会多出空行。
      // 这里去掉行尾单次换行（含 CRLF），使事件累积路径与「从日志文件重载」
      // 路径（split('\n')）的归一化结果保持一致，避免首屏出现多余空行。
      const normalized = text.replace(/\r?\n$/, '')
      setOutputs((prev) => {
        const lines = [...(prev[task_id] ?? []), { source, text: normalized }]
        return { ...prev, [task_id]: lines }
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
        const textLines =
          rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
            ? rawLines.slice(0, -1)
            : rawLines
        // 日志文件不区分 stdout/stderr，一律按普通文本回显
        const lines: OutputLine[] = textLines.map((text) => ({ source: 'stdout', text }))
        setOutputs((prev) => ({ ...prev, [id]: lines }))
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
      auto_run_on_launch: false,
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
        [id]: [...(prev[id] ?? []), { source: 'stdout' as const, text: `[错误] ${String(e)}` }],
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

  // 快速切换终端高度：紧凑 180px <-> 展开 450px，与拖拽边界 (100-600) 兼容
  const handleToggleHeight = () => {
    const next = terminalHeight <= 300 ? 450 : 180
    setTerminalHeight(next)
    localStorage.setItem('terminal-height', String(next))
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
          <Fragment key={form.id}>
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
              terminalHeight={terminalHeight}
              onStart={handleStart}
              onStop={handleStop}
              onClearLog={handleClearLog}
              onToggleHeight={handleToggleHeight}
            />
            <OutputPanel
              lines={outputs[selected.task.id] ?? EMPTY_OUTPUT_LINES}
              height={terminalHeight}
              outputRef={outputRef}
              onMouseDownResize={handleResizeStart}
            />
          </Fragment>
        )}
      </main>

      <SettingsModal ref={settingsRef} />
    </div>
  )
}

export default App
