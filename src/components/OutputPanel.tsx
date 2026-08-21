import type { RefObject } from 'react'
import './OutputPanel.css'

interface OutputPanelProps {
  html: string
  height: number
  outputRef: RefObject<HTMLDivElement | null>
  onMouseDownResize: (e: React.MouseEvent) => void
}

export default function OutputPanel({ html, height, outputRef, onMouseDownResize }: OutputPanelProps) {
  return (
    <>
      <div className="resize-handle" onMouseDown={onMouseDownResize} />
      <div
        className="output"
        ref={outputRef}
        style={{ height }}
        dangerouslySetInnerHTML={{
          __html: html || '<span class="out-empty">（暂无输出）</span>',
        }}
      />
    </>
  )
}
