import type { TaskInfo, TaskStatus } from '../types'
import './Sidebar.css'

function statusInfo(s: TaskStatus) {
  switch (s) {
    case 'running':
      return { label: '运行中', cls: 'st-running' }
    case 'crashed':
      return { label: '已崩溃', cls: 'st-crashed' }
    default:
      return { label: '已停止', cls: 'st-stopped' }
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
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>服务管理器</h1>
        <button className="btn btn-primary" onClick={onAdd}>
          + 添加任务
        </button>
      </div>
      <ul className="task-list">
        {tasks.map((t) => {
          const si = statusInfo(t.status)
          return (
            <li
              key={t.task.id}
              className={`task-item ${t.task.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(t.task.id)}
            >
              <span className={`dot ${si.cls}`} />
              <span className="task-name">{t.task.name}</span>
              <span className={`status-label ${si.cls}`}>{si.label}</span>
            </li>
          )
        })}
        {tasks.length === 0 && <li className="empty-tip">暂无任务</li>}
      </ul>
      <div className="sidebar-footer">
        <button className="btn btn-settings" onClick={onOpenSettings}>
          ⚙ 设置
        </button>
      </div>
    </aside>
  )
}
