import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface SettingsModalHandle {
  open: () => void
}

const SettingsModal = forwardRef<SettingsModalHandle>(function SettingsModal(_props, ref) {
  const [visible, setVisible] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  const [autoRestore, setAutoRestore] = useState(false)
  const [silentStart, setSilentStart] = useState(false)
  const [keepAlive, setKeepAlive] = useState(true)

  useEffect(() => {
    invoke<boolean>('get_setting_auto_restore').then(setAutoRestore).catch(() => {})
    invoke<boolean>('get_setting_silent_start').then(setSilentStart).catch(() => {})
    invoke<boolean>('get_setting_keep_alive').then(setKeepAlive).catch(() => {})
    invoke<boolean>('get_autostart').then(setAutoStart).catch(() => {})
  }, [])

  useImperativeHandle(ref, () => ({
    open: () => setVisible(true),
  }))

  const toggleAutoStart = (v: boolean) => {
    setAutoStart(v)
    invoke('set_autostart', { value: v }).catch(() => {})
  }

  const toggleAutoRestore = (v: boolean) => {
    setAutoRestore(v)
    invoke('set_setting_auto_restore', { value: v }).catch(() => {})
  }

  const toggleSilentStart = (v: boolean) => {
    setSilentStart(v)
    invoke('set_setting_silent_start', { value: v }).catch(() => {})
  }

  const toggleKeepAlive = (v: boolean) => {
    setKeepAlive(v)
    invoke('set_setting_keep_alive', { value: v }).catch(() => {})
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
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] text-fg">开机自启</span>
              <span className="text-xs text-fg-muted leading-snug">
                登录 Windows 后自动启动本应用
              </span>
            </div>
            <label className="switch shrink-0">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(e) => toggleAutoStart(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] text-fg">允许后台继续运行</span>
              <span className="text-xs text-fg-muted leading-snug">
                开启：关闭主窗口仅隐藏到系统托盘；关闭：关闭主窗口即退出应用
              </span>
            </div>
            <label className="switch shrink-0">
              <input
                type="checkbox"
                checked={keepAlive}
                onChange={(e) => toggleKeepAlive(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] text-fg">自动恢复任务</span>
              <span className="text-xs text-fg-muted leading-snug">
                退出时停止全部运行中的任务，重新打开应用后自动恢复它们
              </span>
            </div>
            <label className="switch shrink-0">
              <input
                type="checkbox"
                checked={autoRestore}
                onChange={(e) => toggleAutoRestore(e.target.checked)}
              />
              <span className="switch-slider" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[13px] text-fg">静默启动</span>
              <span className="text-xs text-fg-muted leading-snug">
                启动后不显示主窗口，直接进入系统托盘
              </span>
            </div>
            <label className="switch shrink-0">
              <input
                type="checkbox"
                checked={silentStart}
                onChange={(e) => toggleSilentStart(e.target.checked)}
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
