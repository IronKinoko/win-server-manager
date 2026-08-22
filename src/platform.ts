// 平台检测：macOS 使用隐藏标题栏（titleBarStyle: Overlay）模式，需自行提供顶部拖拽区并为红绿灯预留空间
export const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
