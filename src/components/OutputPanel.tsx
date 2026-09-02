import { useLayoutEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

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
  const terminalRef = useRef<Terminal | null>(null)
  const writtenLineCountRef = useRef(0)

  // 实时跟踪视口是否贴近底部（随容器 scroll 事件更新）。
  // 原先在 effect 清理函数里判断“是否贴底”，而清理函数运行在新内容布局之后：
  // 一条新消息增高超过 50px 时，会把“原本在底部”误判为“不在底部”，
  // 导致后续新消息不再自动滚到最下方。
  const nearBottomRef = useRef(true)

  useLayoutEffect(() => {
    const el = outputRef.current
    if (!el) return

    const terminal = new Terminal({
      convertEol: true,
      disableStdin: true,
      fontFamily: `'JetBrainsMono Nerd Font', 'FiraCode Nerd Font',Menlo, Monaco, 'Courier New', monospace`,
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.5,
      scrollback: 10_000,
      theme: {
        background: '#0c0c0c',
        foreground: '#e5e7eb',
        selectionBackground: 'rgba(59, 130, 246, 0.45)',
        selectionForeground: '#ffffff',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(el)
    const fit = () => fitAddon.fit()
    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(el)
    fit()
    terminal.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        terminal.selectAll()
        return false
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
        const selection = terminal.getSelection()
        if (!selection) return true
        void navigator.clipboard.writeText(selection)
        return false
      }
      return true
    })
    terminal.onScroll(() => {
      nearBottomRef.current = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
    })
    terminalRef.current = terminal

    return () => {
      terminalRef.current = null
      writtenLineCountRef.current = 0
      resizeObserver.disconnect()
      terminal.dispose()
    }
  }, [outputRef])

  // 新输出到达且用户贴近底部时，把滚动条定位到最下方
  useLayoutEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    if (lines.length === 0) {
      terminal.clear()
      writtenLineCountRef.current = 0
      return
    }

    const newLines = lines.slice(writtenLineCountRef.current)
    if (newLines.length === 0) return
    terminal.write(newLines.map((line) => `${line.text.replace(/\r\n/g, '\n')}\n`).join(''))
    writtenLineCountRef.current = lines.length
    if (nearBottomRef.current) terminal.scrollToBottom()
  }, [lines, outputRef])

  return (
    <>
      <div
        className="h-1 bg-line cursor-row-resize shrink-0 transition-colors hover:bg-accent"
        onMouseDown={onMouseDownResize}
      />
      <div className="pl-5 pt-3 bg-[#0c0c0c]">
        <div
          ref={outputRef}
          className="xterm-output relative m-0 overflow-hidden tracking-normal shrink-0"
          style={{ height }}
        >
          {lines.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 z-10 font-mono text-sm leading-6 text-[#5e6e82]">
              (暂无输出)
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

export default OutputPanel
