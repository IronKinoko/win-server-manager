import { useEffect, useMemo } from 'react'
import { AnsiUp } from 'ansi_up'

/** 一行输出（来源 + 原始文本，保留后端发来的 ANSI 序列） */
export interface OutputLine {
  source: 'stdout' | 'stderr'
  text: string
}

interface OutputPanelProps {
  lines: OutputLine[]
  height: number
  outputRef: React.RefObject<HTMLDivElement | null>
  onMouseDownResize: (e: React.MouseEvent) => void
}

function OutputPanel({ lines, height, outputRef, onMouseDownResize }: OutputPanelProps) {
  // ANSI -> HTML：SGR/CSI/OSC 交给 ansi_up 解析，换行由 <pre> 的 whitespace-pre-wrap 保持
  const html = useMemo(() => {
    if (lines.length === 0) return ''
    const text = lines.map((l) => l.text.replace(/\r\n/g, '\n')).join('\n')
    const ansifier = new AnsiUp()
    ansifier.use_classes = true
    ansifier.faintStyle = 'opacity:0.6;'

    return ansifier.ansi_to_html(text)
  }, [lines])

  // 新输出到达时自动滚到底部
  useEffect(() => {
    const el = outputRef.current
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 50) el.scrollTop = el.scrollHeight
  }, [lines, outputRef])

  // Ctrl/Cmd + A 仅全选输出区内容：监听器直接挂在容器上，
  // 只有焦点位于该子树内（容器本身可聚焦）时 keydown 才会冒泡到这里
  const handleSelectAll = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) return
    const el = outputRef.current
    if (!el) return
    event.preventDefault()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  return (
    <>
      <div
        className="h-1 bg-line cursor-row-resize shrink-0 transition-colors hover:bg-accent"
        onMouseDown={onMouseDownResize}
      />
      {/* tabIndex=0 让容器可聚焦，焦点在输出区内时 keydown 才会冒泡到此触发全选 */}
      <div
        ref={outputRef}
        tabIndex={0}
        onKeyDown={handleSelectAll}
        className="relative m-0 overflow-auto bg-[#0c0c0c] px-5 py-3 shrink-0 select-text font-mono text-sm leading-6 outline-none ansi-output"
        style={{ height }}
      >
        {lines.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 px-5 py-3 text-[#5e6e82]">
            (暂无输出)
          </div>
        ) : (
          <pre
            className="m-0 whitespace-pre-wrap wrap-break-word"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
      </div>
    </>
  )
}

export default OutputPanel
