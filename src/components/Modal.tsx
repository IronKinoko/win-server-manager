import type { ReactNode } from 'react'
import { IconClose } from './icons'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 面板宽度覆写，默认与设置弹窗一致 */
  panelClassName?: string
}

/** 全局模态框：覆盖层点击关闭，✕ 按钮触发 onClose */
export default function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  panelClassName = 'min-w-90 max-w-120 w-[90%]',
}: ModalProps) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-1000"
      onClick={onClose}
    >
      <div
        className={`bg-panel border border-line rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.5)] ${panelClassName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 className="m-0 text-base font-semibold">{title}</h2>
          <button
            className="btn-base px-3 py-1 text-xs flex items-center justify-center"
            onClick={onClose}
          >
            <IconClose className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="p-4 flex flex-col gap-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-line">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
