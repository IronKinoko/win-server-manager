import type { TaskInfo, TaskStatus } from '../types'
import { IS_MAC } from '../platform'

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
  onOpenSettings: () => void
}

export default function Sidebar({
  tasks,
  selectedId,
  onSelect,
  onAdd,
  onOpenSettings,
}: SidebarProps) {
  // 按名称首字母排序（中文走拼音序，不改动原始数组顺序）
  const sorted = [...tasks].sort((a, b) => a.task.name.localeCompare(b.task.name, 'zh-Hans-CN'))
  return (
    <aside className="w-70 min-w-70 bg-panel border-r border-line flex flex-col">
      {/* macOS：整个头部为透明拖拽区（按住空白拖动窗口），顶部加高内边距让标题避开左上角红绿灯；
          「+ 添加任务」按钮由 Tauri 脚本自动豁免，保持正常点击 */}
      <div
        className={`${IS_MAC ? 'pt-8' : 'pt-3'} px-4 pb-3 border-b border-line flex flex-col gap-3 ${
          IS_MAC ? 'cursor-default' : ''
        }`}
        {...(IS_MAC ? { 'data-tauri-drag-region': 'deep' } : {})}
      >
        <button className="btn-primary" onClick={onAdd}>
          + 添加任务
        </button>
      </div>
      <ul className="list-none m-0 p-2 overflow-y-auto flex-1">
        {sorted.map((t) => {
          const si = statusCls(t.status)
          return (
            <li
              key={t.task.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer select-none transition-colors ${
                t.task.id === selectedId ? 'bg-accent/18' : 'hover:bg-white/5'
              }`}
              onClick={() => onSelect(t.task.id)}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${si.dot}`} />
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {t.task.name}
              </span>
              <span className={`text-xs shrink-0 ${si.label}`}>{si.text}</span>
            </li>
          )
        })}
        {tasks.length === 0 && <li className="text-fg-muted text-center py-6 text-sm">暂无任务</li>}
      </ul>
      <div className="px-3 py-3 border-t border-line shrink-0">
        <button className="btn-base w-full text-left" onClick={onOpenSettings}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
