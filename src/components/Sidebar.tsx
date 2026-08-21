import type { TaskInfo, TaskStatus } from '../types'

function statusCls(s: TaskStatus) {
  switch (s) {
    case 'running': return { dot: 'bg-success', label: 'text-success', text: '运行中' }
    case 'crashed': return { dot: 'bg-danger', label: 'text-danger', text: '已崩溃' }
    default: return { dot: 'bg-idle', label: 'text-idle', text: '已停止' }
  }
}

interface SidebarProps {
  tasks: TaskInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onOpenSettings: () => void
}

export default function Sidebar({ tasks, selectedId, onSelect, onAdd, onOpenSettings }: SidebarProps) {
  // 按名称首字母排序（中文走拼音序，不改动原始数组顺序）
  const sorted = [...tasks].sort((a, b) => a.task.name.localeCompare(b.task.name, 'zh-Hans-CN'))
  return (
    <aside className="w-[280px] min-w-[280px] bg-panel border-r border-line flex flex-col">
      <div className="p-3.5 border-b border-line flex flex-col gap-2.5">
        <h1 className="m-0 text-base font-semibold">服务管理器</h1>
        <button className="btn-primary" onClick={onAdd}>+ 添加任务</button>
      </div>
      <ul className="list-none m-0 p-2 overflow-y-auto flex-1">
        {sorted.map((t) => {
          const si = statusCls(t.status)
          return (
            <li
              key={t.task.id}
              className={`flex items-center gap-2 px-2.5 py-[9px] rounded-md cursor-pointer select-none transition-colors ${
                t.task.id === selectedId ? 'bg-accent/[0.18]' : 'hover:bg-white/5'
              }`}
              onClick={() => onSelect(t.task.id)}
            >
              <span className={`w-[9px] h-[9px] rounded-full shrink-0 ${si.dot}`} />
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t.task.name}</span>
              <span className={`text-xs shrink-0 ${si.label}`}>{si.text}</span>
            </li>
          )
        })}
        {tasks.length === 0 && (
          <li className="text-fg-muted text-center py-6 text-[13px]">暂无任务</li>
        )}
      </ul>
      <div className="px-3 py-2.5 border-t border-line shrink-0">
        <button className="btn-base w-full text-left" onClick={onOpenSettings}>⚙ 设置</button>
      </div>
    </aside>
  )
}
