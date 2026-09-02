import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { compilePretty, prettyLines, type PrettyFn } from '../prettyOutput'

/** 一行输出（来源 + 原始文本，保留后端发来的 ANSI 序列） */
export interface OutputLine {
  source: 'stdout' | 'stderr'
  text: string
}

/** 美化代码变化后，历史全量重渲染的防抖时长（ms）：
    输入时每个按键都会改代码，逐次立即重写整屏历史开销太大；增量新输出不受此防抖影响 */
const PRETTY_RERENDER_DEBOUNCE_MS = 300

interface OutputPanelProps {
  lines: OutputLine[]
  height: number
  outputRef: React.RefObject<HTMLDivElement | null>
  onMouseDownResize: (e: React.MouseEvent) => void
  prettyCode?: string
}

function OutputPanel({
  lines,
  height,
  outputRef,
  onMouseDownResize,
  prettyCode,
}: OutputPanelProps) {
  const terminalRef = useRef<Terminal | null>(null)
  const writtenLineCountRef = useRef(0)

  const prettyFn = useMemo(() => (prettyCode ? compilePretty(prettyCode).fn : null), [prettyCode])
  const prettyRef = useRef<PrettyFn | null>(null)
  useLayoutEffect(() => {
    prettyRef.current = prettyFn
  }, [prettyFn])
  // 上次写入时生效的美化代码；与当前 prettyCode 不一致时，终端需用新函数重渲染全部历史
  const prettyCodeUsedRef = useRef(prettyCode)
  // 最新 lines 快照：防抖的全量重写在 timeout 闭包里执行，必须从 ref 读取；
  // 也让防抖 effect 无需依赖 lines（否则每条新输出都会重置防抖计时）
  const linesRef = useRef<OutputLine[]>([])

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
        // 配色参考 VS Code 主题 One Dark Pro（Binaryify/OneDark-Pro，已核对官方 theme JSON）：
        // 背景/前景/光标/选区取自该主题的 terminal.* / editorCursor 定义；
        // 该主题未定义 terminal.ansiColors，16 色 ANSI 取自其 token 配色
        background: '#151517',
        foreground: '#e5e7eb',
        selectionBackground: 'rgba(59, 130, 246, 0.45)',
        selectionForeground: '#ffffff',
        cursor: '#528bff',
        black: '#3f4451',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#e5c07b',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#4cb19d',
        white: '#dcdcdc',
        brightBlack: '#5c6370',
        brightRed: '#e06c75',
        brightGreen: '#98c379',
        brightYellow: '#e5c07b',
        brightBlue: '#61afef',
        brightMagenta: '#c678dd',
        brightCyan: '#56b6c2',
        brightWhite: '#ffffff',
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
  // （增量写入不做防抖；美化代码变化时重渲染整屏历史见下方防抖 effect）
  useLayoutEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    linesRef.current = lines

    if (lines.length === 0) {
      terminal.clear()
      writtenLineCountRef.current = 0
      return
    }

    const newLines = lines.slice(writtenLineCountRef.current)
    if (newLines.length === 0) return
    // 先归一化新增的一批行，再交给用户 pretty 函数美化（按增量批次调用），最后逐行写入终端；
    // 美化抛错或返回异常时回退原文（见 prettyLines），不中断增量渲染
    let texts = newLines.map((line) => line.text.replace(/\r\n/g, '\n'))
    const pretty = prettyRef.current
    if (pretty) texts = prettyLines(pretty, texts)
    terminal.writeln(texts.join('\n'))
    writtenLineCountRef.current = lines.length
    if (nearBottomRef.current) terminal.scrollToBottom()
  }, [lines, outputRef])

  // 美化代码变化：立即标记已消费（连续改动会被合并），防抖到期后
  // 清空终端并用新函数重写全部历史（期间到达的增量新输出不受影响）
  useEffect(() => {
    if (prettyCodeUsedRef.current === prettyCode) return
    prettyCodeUsedRef.current = prettyCode
    const timer = window.setTimeout(() => {
      const terminal = terminalRef.current
      if (!terminal) return
      terminal.clear()
      const all = linesRef.current
      if (all.length === 0) {
        writtenLineCountRef.current = 0
        return
      }
      let texts = all.map((line) => line.text.replace(/\r\n/g, '\n'))
      const pretty = prettyRef.current
      if (pretty) texts = prettyLines(pretty, texts)
      terminal.writeln(texts.join('\n'))
      writtenLineCountRef.current = all.length
      if (nearBottomRef.current) terminal.scrollToBottom()
    }, PRETTY_RERENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [prettyCode, outputRef])

  return (
    <>
      <div
        className="h-1 bg-line cursor-row-resize shrink-0 transition-colors hover:bg-accent"
        onMouseDown={onMouseDownResize}
      />
      <div className="pl-5 pt-3 bg-[#151517]">
        <div
          ref={outputRef}
          className="xterm-output relative m-0 overflow-hidden tracking-normal shrink-0"
          style={{ height }}
        >
          {lines.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 z-10 font-mono text-sm leading-6 text-[#5c6370]">
              (暂无输出)
            </div>
          ) : null}
        </div>
      </div>
    </>
  )
}

export default OutputPanel
