import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/** 一行输出（来源 + 原始文本，保留后端发来的 ANSI 序列） */
export interface OutputLine {
  source: 'stdout' | 'stderr'
  text: string
}

export interface OutputPanelHandle {
  selectAll: () => void
}

interface OutputPanelProps {
  taskId: string
  lines: OutputLine[]
  height: number
  outputRef: React.RefObject<HTMLDivElement | null>
  onMouseDownResize: (e: React.MouseEvent) => void
}

const MONO_FONT =
  "'JetBrainsMono Nerd Font', 'FiraCode Nerd Font',Menlo, Monaco, 'Cascadia Code', 'Cascadia Mono', Consolas"

/**
 * 单行渲染为终端数据：统一归一化成 LF 换行并补上缺失的行尾，最后转成 CRLF 写入。
 * xterm 里裸 \n 只下移一行且保持列位置不变（会逐行水平右移），必须先 \r 回零列；
 * 换行边界本身保持不变，ANSI 序列原样透传由 xterm 解析
 */
function renderLine(line: OutputLine): string {
  let text = line.text.replace(/\r\n/g, '\n')
  if (!text.endsWith('\n')) text += '\n'

  return text.replace(/\n/g, '\r\n')
}

const OutputPanel = forwardRef<OutputPanelHandle, OutputPanelProps>(function OutputPanel(
  { taskId, lines, height, outputRef, onMouseDownResize },
  ref,
) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // xterm 挂载点：内层无边距，FitAddon 按它的盒模型算行列；外层的 padding 不会把文字裁掉
  const fitHostRef = useRef<HTMLDivElement>(null)
  // 上一次实际写入终端的任务与行数快照，用于区分「追加」与「整段替换」
  const renderedTaskRef = useRef<string | null>(null)
  const renderedLinesRef = useRef<OutputLine[]>([])

  // 创建/销毁 xterm 实例（随组件挂载一次）
  useEffect(() => {
    const el = fitHostRef.current
    if (!el) return
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'block',
      disableStdin: true,
      fontFamily: MONO_FONT,
      fontSize: 14,
      // 与原 leading-6（24px/14px ≈ 1.7）的行高节奏一致
      lineHeight: 1.7,
      scrollback: 10000,
      theme: {
        background: '#0c0c0c',
        foreground: '#dce3ea',
        // 只读输出视图：块状光标与背景同色（字色用 cursorAccent 保持可读），光标近乎不可见
        cursor: '#0c0c0c',
        cursorAccent: '#dce3ea',
        selectionBackground: '#264f78',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      // 容器尚未布局时忽略
    }
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 同上
      }
    })
    ro.observe(el)
    // 新实例是空的：清掉旧快照，让写入 effect 整体重写（StrictMode 重挂载同理）
    renderedTaskRef.current = null
    renderedLinesRef.current = []
    termRef.current = term
    fitRef.current = fit
    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // fitHostRef 是组件内稳定 ref，实例只需随挂载创建一次
  }, [])

  // 把输出行写入终端：同任务纯追加走增量写入，否则 reset 后整体重写
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const prev = renderedLinesRef.current
    let appendFrom = -1
    if (renderedTaskRef.current === taskId && lines.length >= prev.length) {
      let isAppend = true
      for (let i = 0; i < prev.length; i++) {
        if (lines[i] !== prev[i]) {
          isAppend = false
          break
        }
      }
      if (isAppend) appendFrom = prev.length
    }
    if (appendFrom >= 0) {
      const data = lines.slice(appendFrom).map(renderLine).join('')
      if (data) term.write(data)
    } else {
      term.reset()
      term.write(lines.map(renderLine).join(''))
    }
    renderedTaskRef.current = taskId
    renderedLinesRef.current = lines
  }, [taskId, lines])

  useImperativeHandle(ref, () => ({
    selectAll: () => {
      const term = termRef.current
      if (term) {
        term.focus()
        term.selectAll()
      }
    },
  }))

  return (
    <>
      <div
        className="h-1 bg-line cursor-row-resize shrink-0 transition-colors hover:bg-accent"
        onMouseDown={onMouseDownResize}
      />
      {/* 外层保留与原样式一致的 padding；内层无边距 div 是 FitAddon 的测量基准，
          若直接给 xterm 容器留 padding，行列数会按含 padding 的全尺寸计算导致文字被裁掉 */}
      <div
        ref={outputRef}
        className="relative m-0 overflow-hidden bg-[#0c0c0c] px-5 py-3 shrink-0 select-text"
        style={{ height }}
      >
        <div ref={fitHostRef} className="h-full w-full" />
        {lines.length === 0 && (
          <div className="pointer-events-none absolute inset-0 px-5 py-3 font-mono text-sm leading-6 text-[#5e6e82]">
            (暂无输出)
          </div>
        )}
      </div>
    </>
  )
})

export default OutputPanel
