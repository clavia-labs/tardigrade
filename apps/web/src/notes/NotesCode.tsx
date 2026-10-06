import { useLayoutEffect, useRef, type ComponentPropsWithoutRef, type ReactElement } from "react"

type NotesCodeProps = ComponentPropsWithoutRef<"pre"> & { readonly highlight?: string | number }

export const NotesCode = ({ highlight, style, ...props }: NotesCodeProps): ReactElement => {
  const preRef = useRef<HTMLPreElement>(null)
  const lines = String(highlight ?? "").split(",").map(Number).filter(line => Number.isSafeInteger(line) && line > 0)
  useLayoutEffect(() => {
    const pre = preRef.current
    const code = pre?.querySelector("code")
    if (!pre || !code || lines.length === 0) return
    const align = (): void => {
      const sourceLines = (code.textContent ?? "").split("\n")
      const preRect = pre.getBoundingClientRect()
      const scale = pre.offsetHeight === 0 ? 1 : preRect.height / pre.offsetHeight
      const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight)
      const positions = lines.map(line => {
        const text = sourceLines[line - 1] ?? ""
        const start = sourceLines.slice(0, line - 1).reduce((offset, value) => offset + value.length + 1, 0) + Math.max(0, text.search(/\S/))
        const end = start + text.trim().length
        const range = document.createRange()
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
        let offset = 0
        let started = false
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0
          if (!started && start < offset + length) {
            range.setStart(node, start - offset)
            started = true
          }
          if (started && end <= offset + length) {
            range.setEnd(node, end - offset)
            const rect = range.getBoundingClientRect()
            const center = ((rect.top + rect.bottom) / 2 - preRect.top) / scale
            return `0 ${center + pre.scrollTop - pre.clientTop - lineHeight / 2}px`
          }
          offset += length
        }
        return `0 calc(var(--notes-code-padding) + ${line - 1} * var(--notes-code-line-height))`
      })
      pre.style.backgroundPosition = positions.join(", ")
    }
    align()
    const observer = new ResizeObserver(align)
    observer.observe(pre)
    let active = true
    void document.fonts.ready.then(() => { if (active) align() })
    return () => { active = false; observer.disconnect() }
  }, [highlight, props.children])
  return <pre {...props} ref={preRef} style={{
    ...(lines.length === 0 ? {} : {
      backgroundImage: lines.map(() => "linear-gradient(var(--code-highlight), var(--code-highlight))").join(", "),
      backgroundPosition: lines.map(line => `0 calc(var(--notes-code-padding) + ${line - 1} * var(--notes-code-line-height))`).join(", "),
      backgroundSize: "100% var(--notes-code-line-height)",
      backgroundRepeat: "no-repeat",
    }),
    ...style,
  }} />
}
