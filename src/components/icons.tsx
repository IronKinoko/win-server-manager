import type { SVGProps } from 'react'

// 统一线形图标集：描边/填充继承 currentColor，尺寸由 className 决定（默认 w-4 h-4）
// 界面字体缺少特殊符号字形（⚙ ⏻ ▶ 等），故全部图标用 SVG 绘制
type IconProps = SVGProps<SVGSVGElement>

function Svg({ className = 'w-4 h-4', children, ...rest }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** 加号 */
export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  )
}

/** 启动（实心三角） */
export function IconPlay(props: IconProps) {
  return (
    <Svg {...props} stroke="none">
      <path d="M7 4.8v14.4L19.5 12Z" fill="currentColor" />
    </Svg>
  )
}

/** 停止（实心方块） */
export function IconStop(props: IconProps) {
  return (
    <Svg {...props} stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
    </Svg>
  )
}

/** 关闭（✕） */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Svg>
  )
}

/** 更多（⋯ 三点） */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props} stroke="none">
      <circle cx="5" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="19" cy="12" r="1.7" fill="currentColor" />
    </Svg>
  )
}

/** 展开/收起（⇕） */
export function IconExpand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m8 7.5 4-4 4 4" />
      <path d="m8 16.5 4 4 4-4" />
    </Svg>
  )
}

/** 电源（完全退出） */
export function IconPower(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <path d="M12 2v10" />
    </Svg>
  )
}

const GEAR_PATH =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z'

/** 齿轮（设置） */
export function IconGear(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d={GEAR_PATH} />
    </Svg>
  )
}
