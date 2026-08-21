import { forwardRef, useImperativeHandle, useState } from 'react'

export interface SettingsModalHandle {
  open: () => void
}

const SettingsModal = forwardRef<SettingsModalHandle>(function SettingsModal(_props, ref) {
  const [visible, setVisible] = useState(false)
  const [autoStart, setAutoStart] = useState(() => localStorage.getItem('autostart') === 'true')

  useImperativeHandle(ref, () => ({
    open: () => setVisible(true),
  }))

  const toggleAutoStart = (v: boolean) => {
    setAutoStart(v)
    localStorage.setItem('autostart', String(v))
  }

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-1000"
      onClick={() => setVisible(false)}
    >
      <div
        className="bg-panel border border-line rounded-[10px] min-w-90 max-w-120 w-[90%] shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4.5 py-3.5 border-b border-line">
          <h2 className="m-0 text-[15px] font-semibold">设置</h2>
          <button className="btn-base px-2.5 py-1 text-xs" onClick={() => setVisible(false)}>
            ✕
          </button>
        </div>
        <div className="p-4 flex flex-col gap-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-fg">允许开机自启</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => toggleAutoStart(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
        </div>
      </div>
    </div>
  )
})

export default SettingsModal
