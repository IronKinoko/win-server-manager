import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import Modal from './Modal'

export interface SettingsModalHandle {
  open: () => void
}

interface SettingsModalProps {
  // 「允许后台继续运行」被切换时通知外层（侧边栏「完全退出」按钮据此显示/隐藏）
  onKeepAliveChange?: (value: boolean) => void
}

const SettingsModal = forwardRef<SettingsModalHandle, SettingsModalProps>(function SettingsModal(
  { onKeepAliveChange },
  ref,
) {
  const [visible, setVisible] = useState(false)
  const [autoStart, setAutoStart] = useState(false)
  const [silentStart, setSilentStart] = useState(false)
  const [keepAlive, setKeepAlive] = useState(true)

  useEffect(() => {
    invoke<boolean>('get_setting_silent_start')
      .then(setSilentStart)
      .catch(() => {})
    invoke<boolean>('get_setting_keep_alive')
      .then(setKeepAlive)
      .catch(() => {})
    invoke<boolean>('get_autostart')
      .then(setAutoStart)
      .catch(() => {})
  }, [])

  useImperativeHandle(ref, () => ({
    open: () => setVisible(true),
  }))

  const toggleAutoStart = (v: boolean) => {
    setAutoStart(v)
    invoke('set_autostart', { value: v }).catch(() => {})
  }

  const toggleSilentStart = (v: boolean) => {
    setSilentStart(v)
    invoke('set_setting_silent_start', { value: v }).catch(() => {})
  }

  const toggleKeepAlive = (v: boolean) => {
    setKeepAlive(v)
    onKeepAliveChange?.(v)
    invoke('set_setting_keep_alive', { value: v }).catch(() => {})
  }

  if (!visible) return null

  return (
    <Modal open={visible} title="设置" onClose={() => setVisible(false)}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm text-fg">开机自启</span>
          <span className="text-xs text-fg-muted leading-snug">登录 Windows 后自动启动本应用</span>
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
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm text-fg">允许后台继续运行</span>
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
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm text-fg">静默启动</span>
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
    </Modal>
  )
})

export default SettingsModal
