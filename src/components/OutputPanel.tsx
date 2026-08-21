import type { RefObject } from 'react'

interface OutputPanelProps {
  html: string
  height: number
  outputRef: RefObject<HTMLDivElement | null>
  onMouseDownResize: (e: React.MouseEvent) => void
}

export default function OutputPanel({ html, height, outputRef, onMouseDownResize }: OutputPanelProps) {
  return (
    <>
      <div
        className="h-[5px] bg-line cursor-row-resize shrink-0 transition-colors hover:bg-accent"
        onMouseDown={onMouseDownResize}
      />
      <div
        ref={outputRef}
        className="m-0 px-5 py-3 bg-[#0c0c0c] text-[#dce3ea] font-mono text-[13.5px] leading-[1.7] overflow-y-auto whitespace-pre-wrap break-all shrink-0"
        style={{ height }}
        dangerouslySetInnerHTML={{
          __html: html || '<span class="out-empty">(暂无输出)</span>',
        }}
      />
    </>
  )
}
