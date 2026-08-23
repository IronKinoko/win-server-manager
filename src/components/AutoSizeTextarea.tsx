import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type TextareaHTMLAttributes,
} from 'react'

export interface AutoSizeTextareaRef {
  resize: () => void
  element: HTMLTextAreaElement | null
}

const AutoSizeTextarea = forwardRef<
  AutoSizeTextareaRef,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function AutoSizeTextarea({ value, onChange, style, ...props }, ref) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const parentScrollRef = useRef<HTMLElement | null>(null)

  const resize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    if (!parentScrollRef.current) {
      let parent: HTMLElement | null = textarea.parentElement
      while (parent) {
        if (parent.scrollHeight > parent.clientHeight) {
          parentScrollRef.current = parent
          break
        }
        parent = parent.parentElement
      }
    }

    if (!parentScrollRef.current) {
      textarea.style.height = '0px'
      textarea.style.height = `${textarea.scrollHeight}px`
      return
    }

    const parentScroll = parentScrollRef.current
    const scrollTopBefore = parentScroll.scrollTop

    textarea.style.height = '0px'
    textarea.style.height = `${textarea.scrollHeight}px`
    parentScroll.scrollTop = scrollTopBefore
  }, [])

  useImperativeHandle(ref, () => ({
    resize,
    element: textareaRef.current,
  }))

  // 内容变化
  useLayoutEffect(() => {
    resize()
  }, [value, resize])

  // 宽度变化导致换行变化
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const observer = new ResizeObserver(resize)

    observer.observe(wrapper)

    return () => observer.disconnect()
  }, [resize])

  return (
    <div ref={wrapperRef} style={{ width: '100%' }}>
      <textarea
        {...props}
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          onChange?.(e)
          resize()
        }}
        style={{
          overflow: 'hidden',
          resize: 'none',
          ...style,
        }}
      />
    </div>
  )
})

export default AutoSizeTextarea
