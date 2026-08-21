import './SettingsModal.css'

interface SettingsModalProps {
  show: boolean
  onClose: () => void
  autoStart: boolean
  onAutoStartChange: (v: boolean) => void
}

export default function SettingsModal({ show, onClose, autoStart, onAutoStartChange }: SettingsModalProps) {
  if (!show) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="btn btn-small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="setting-row">
            <span className="setting-label">允许开机自启</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => onAutoStartChange(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
