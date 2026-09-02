import { useEffect, useState } from 'react'
import type { TaskInfo, TaskStatus } from '../types'
import { IS_MAC } from '../platform'
import { IconGear, IconMore, IconPlus, IconPower } from './icons'

function statusCls(s: TaskStatus) {
  switch (s) {
    case 'running':
      return { dot: 'bg-success', label: 'text-success', text: '运行中' }
    case 'crashed':
      return { dot: 'bg-danger', label: 'text-danger', text: '已崩溃' }
    default:
      return { dot: 'bg-idle', label: 'text-idle', text: '已停止' }
  }
}

interface SidebarProps {
  tasks: TaskInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onCopy: (task: TaskInfo) => void
  onDelete: (task: TaskInfo) => void
  onOpenSettings: () => void
  // 是否开启「允许后台继续运行」：开启时左下角显示「完全退出」按钮
  keepAlive: boolean
  onQuit: () => void
  // 侧边栏宽度（px，由 App 持久化）与右边缘拖拽调整入口
  width: number
  onResizeStart: (e: React.PointerEvent) => void
}

export default function Sidebar({
  tasks,
  selectedId,
  onSelect,
  onAdd,
  onCopy,
  onDelete,
  onOpenSettings,
  keepAlive,
  onQuit,
  width,
  onResizeStart,
}: SidebarProps) {
  // 同一时刻最多展开一个任务的 "···" 菜单
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  // 点击菜单外部（含空白处、其他任务项）时关闭菜单
  useEffect(() => {
    if (menuOpenId === null) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLElement) || !e.target.closest('[data-task-menu]')) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [menuOpenId])

  // 按名称首字母排序（中文走拼音序，不改动原始数组顺序）
  const sorted = [...tasks].sort((a, b) => a.task.name.localeCompare(b.task.name, 'zh-Hans-CN'))
  return (
    <aside
      className="shrink-0 relative bg-panel border-r border-line flex flex-col"
      style={{ width }}
    >
      {/* 右边缘拖拽手柄：12px 命中区（不侵占行内 12px 内边距）+ 1px 常驻细线提示，hover 高亮；拖拽逻辑（边界 + 持久化）在 App 中 */}
      <div
        className="absolute top-0 right-0 h-full w-3 cursor-col-resize z-10 touch-none"
        onPointerDown={onResizeStart}
      >
        <div className="h-full w-px ml-auto bg-white/25 hover:bg-accent transition-colors" />
      </div>
      {/* macOS：整个头部为透明拖拽区（按住空白拖动窗口），顶部加高内边距让标题避开左上角红绿灯；
          「+ 添加任务」按钮由 Tauri 脚本自动豁免，保持正常点击 */}
      <div
        className={`${IS_MAC ? 'pt-8' : 'pt-3'} px-4 pb-3 border-b border-line flex flex-col gap-3 ${
          IS_MAC ? 'cursor-default' : ''
        }`}
        {...(IS_MAC ? { 'data-tauri-drag-region': 'deep' } : {})}
      >
        <button
          className="btn-primary flex items-center justify-center gap-1.5 leading-none"
          onClick={onAdd}
        >
          <IconPlus className="w-4 h-4 shrink-0" />
          添加任务
        </button>
      </div>
      <ul className="list-none m-0 p-2 overflow-y-auto flex-1">
        {sorted.map((t) => {
          const si = statusCls(t.status)
          const menuOpen = menuOpenId === t.task.id
          return (
            <li
              key={t.task.id}
              className={`relative group flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer select-none transition-colors ${
                t.task.id === selectedId ? 'bg-accent/18' : 'hover:bg-white/5'
              }`}
              onClick={() => onSelect(t.task.id)}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${si.dot}`} />
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {t.task.name}
              </span>
              {/* 状态标签与 ⋯ 按钮共用同一槽位（宽度随文字自适应）：默认显示状态，hover 时隐藏状态并原位显示 ⋯ */}
              <span className="relative shrink-0 h-6 flex items-center">
                <span
                  className={`block text-xs whitespace-nowrap ${si.label} ${
                    menuOpen ? 'invisible' : 'group-hover:invisible'
                  }`}
                >
                  {si.text}
                </span>
                <button
                  data-task-menu
                  className={`absolute right-0 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-fg-muted cursor-pointer transition-opacity hover:bg-white/10 hover:text-fg ${
                    menuOpen
                      ? 'opacity-100'
                      : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpenId(menuOpen ? null : t.task.id)
                  }}
                >
                  <IconMore className="w-4 h-4" />
                </button>
              </span>
              {menuOpen && (
                <div
                  data-task-menu
                  className="absolute right-2 top-9 z-50 min-w-20 bg-panel border border-line rounded-md shadow-lg py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm cursor-pointer hover:bg-white/10 rounded-sm"
                    onClick={() => {
                      setMenuOpenId(null)
                      onCopy(t)
                    }}
                  >
                    复制
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 text-sm text-danger cursor-pointer hover:bg-white/10 rounded-sm"
                    onClick={() => {
                      setMenuOpenId(null)
                      onDelete(t)
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
            </li>
          )
        })}
        {tasks.length === 0 && <li className="text-fg-muted text-center py-6 text-sm">暂无任务</li>}
      </ul>
      <div className="px-3 py-3 border-t border-line shrink-0 flex flex-col gap-2">
        <button
          className="btn-base w-full text-left flex items-center gap-1.5 leading-none"
          onClick={onOpenSettings}
        >
          <IconGear className="w-4 h-4 shrink-0" />
          设置
        </button>
        {keepAlive && (
          <button
            className="btn-danger w-full text-left flex items-center gap-1.5 leading-none"
            title="停止全部任务并完全退出程序（不进入后台）"
            onClick={onQuit}
          >
            <IconPower className="w-4 h-4 shrink-0" />
            完全退出
          </button>
        )}
      </div>
    </aside>
  )
}
