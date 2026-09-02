import { useSyncExternalStore } from 'react'
import chalk from 'chalk'

/**
 * 「美化输出」功能的前端核心：
 * 用户在任务表单的 textarea 里写一段 JS 代码（定义 function pretty(lines: string[], { chalk }): string[]），
 * 代码作为任务配置字段随任务持久化到后端（tasks.json），求值与渲染全部在前端完成。
 *
 * 模块级 store 负责在 TaskForm（写）与 OutputPanel（读）之间同步当前激活的代码，
 * 这样 App.tsx 无需为 OutputPanel 增加任何 props。
 */

/** 美化函数：接收一批增量输出行和上下文（{ chalk }），返回美化后的行（可返回不同行数，返回 ANSI 序列即可显示颜色） */
export type PrettyFn = (lines: string[], ctx: { chalk: typeof chalk }) => string[]

export interface CompileResult {
  fn: PrettyFn | null
  error: string | null
}

// ---- 模块级 store：当前终端生效的美化代码 ----

let activeCode = ''
const listeners = new Set<() => void>()

export function setPrettyCode(code: string) {
  if (code === activeCode) return
  activeCode = code
  listeners.forEach((l) => l())
}

export function subscribePrettyCode(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPrettyCode() {
  return activeCode
}

/** 订阅当前生效的美化代码（TaskForm 修改/切换任务时触发 OutputPanel 重算） */
export function usePrettyCode() {
  return useSyncExternalStore(subscribePrettyCode, getPrettyCode)
}

// ---- 编译用户代码 ----

// 约定：代码需定义 function pretty(lines: string[]): string[]（JS 写法，
// 占位符里的 TS 类型标注仅作提示，用户自行改写时去掉即可）。
export function compilePretty(codeText: string): CompileResult {
  const code = codeText.trim()
  if (!code) return { fn: null, error: null }
  try {
    const factory = new Function(`${code}\n;return typeof pretty === 'function' ? pretty : null;`)
    const pretty = factory()
    if (typeof pretty !== 'function') {
      return { fn: null, error: '代码需定义 function pretty(lines: string[], { chalk }): string[]' }
    }
    // 冒烟测试：确保可调用且返回数组，坏代码不会在渲染路径上抛错
    const probe = pretty([''], { chalk })
    if (!Array.isArray(probe)) {
      return { fn: null, error: 'pretty 必须返回 string[]' }
    }
    return { fn: pretty, error: null }
  } catch (e) {
    return { fn: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 执行美化函数（第二参数传入 { chalk }）；抛错或返回非数组时回退原始行，保证增量渲染不中断 */
export function prettyLines(pretty: PrettyFn, lines: string[]): string[] {
  try {
    const result = pretty(lines, { chalk })
    if (!Array.isArray(result)) return lines
    return result.map((item) => (typeof item === 'string' ? item : String(item)))
  } catch {
    return lines
  }
}
