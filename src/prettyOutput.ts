import chalk from 'chalk'

/**
 * 「美化输出」功能的前端核心：
 * 页面把外层函数壳（function pretty(lines, { chalk }) { … } 的首行与末行）作为固定文本渲染，
 * 用户在任务表单的 textarea 里只写函数体（JS 片段），
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

// 固定函数壳：textarea 只保存函数体，编译时包进这个壳再求值
const PRETTY_SHELL = 'function pretty(lines, { chalk }) {\n%s\n}'

export function compilePretty(codeText: string): CompileResult {
  const code = codeText.trim()
  if (!code) return { fn: null, error: null }
  // 兼容旧数据：早期任务里保存的是完整函数定义（自带 function pretty … 外壳），直接原样求值
  const fullCode = /function\s+pretty\s*\(/.test(code) ? code : PRETTY_SHELL.replace('%s', code)
  try {
    const factory = new Function(
      `${fullCode}\n;return typeof pretty === 'function' ? pretty : null;`,
    )
    const pretty = factory()
    if (typeof pretty !== 'function') {
      return { fn: null, error: '函数体无效：需返回美化后的行（string[]）' }
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
