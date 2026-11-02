import { Children, isValidElement, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { CheckIcon, CopyIcon, useCopy } from "../../ui/copy"
import { ChevronIcon } from "./icons"

export const Command = ({ label, value }: { readonly label?: string; readonly value: string }): ReactElement => {
  const [copied, copy] = useCopy()
  return (
    <div className="guide-command">
      <div className="install-command" aria-label={label ?? value}>
        <span aria-hidden="true">$</span>
        <code>{value}</code>
        <button type="button" aria-label={copied ? "Command copied" : "Copy command"} title={copied ? "Copied" : "Copy command"} onClick={() => void copy(value)}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  )
}

type CodeFileProps = { readonly name: string; readonly children: ReactNode }
export const CodeFile = ({ children }: CodeFileProps): ReactElement => <>{children}</>
export const CodeFiles = ({ children, selected }: { readonly children: ReactNode; readonly selected?: string }): ReactElement => {
  const files = Children.toArray(children).filter(isValidElement<CodeFileProps>)
  const [active, setActive] = useState(selected ?? files[0]?.props.name)
  const id = useId()
  return <div className="docs-code-files">
    <div className="docs-code-files-nav" role="tablist" aria-label="Example files">
      {files.map((file, index) => <button type="button" role="tab" key={file.props.name} id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={active === file.props.name} tabIndex={active === file.props.name ? 0 : -1} onClick={() => setActive(file.props.name)} onKeyDown={event => {
        const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0
        if (offset === 0 && event.key !== "Home" && event.key !== "End") return
        event.preventDefault()
        const next = event.key === "Home" ? 0 : event.key === "End" ? files.length - 1 : (index + offset + files.length) % files.length
        setActive(files[next]!.props.name)
        document.getElementById(`${id}-tab-${next}`)?.focus()
      }}>{file.props.name}</button>)}
    </div>
    {files.map((file, index) => <div className="docs-code-files-panel" role="tabpanel" key={file.props.name} id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={active !== file.props.name} tabIndex={0}>{file.props.children}</div>)}
  </div>
}

export const textFrom = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFrom).join("")
  if (isValidElement<{ readonly children?: ReactNode }>(node)) return textFrom(node.props.children)
  return ""
}

const languageOf = (children: ReactNode): string => {
  if (!isValidElement<{ readonly className?: string }>(children)) return "text"
  const match = /(?:^|\s)language-([^\s]+)/.exec(children.props.className ?? "")
  return match?.[1] ?? "text"
}

type CodeProps = ComponentPropsWithoutRef<"pre"> & {
  readonly expanded?: boolean | undefined
  readonly collapsed?: boolean | undefined
  readonly highlight?: number | string | undefined
  readonly variant?: "diagram" | "multi" | "single" | undefined
}

const highlightLines = (value: number | string | undefined): { readonly first: number; readonly count: number } | undefined => {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value ?? ""))
  if (match === null) return undefined
  const first = Number(match[1])
  const last = Number(match[2] ?? match[1])
  return first > 0 && last >= first ? { first, count: last - first + 1 } : undefined
}

export const Code = ({ children, title, expanded = false, collapsed = false, highlight, variant = "multi", ...props }: CodeProps): ReactElement => {
  const [copied, copy] = useCopy()
  const [opened, setOpened] = useState(expanded)
  const bodyId = useId()
  const codeRoot = useRef<HTMLDivElement>(null)
  const initiallyScrolled = useRef(false)
  const language = languageOf(children)
  const lineHeight = 20
  const highlighted = highlightLines(highlight)
  const highlightedLine = highlighted?.first ?? 0
  const highlightedCount = highlighted?.count ?? 0
  const hasHighlight = highlighted !== undefined
  const codeStyle = {
    "--docs-code-line-height": `${lineHeight}px`,
    ...(highlighted === undefined ? {} : {
      "--docs-highlight-height": `${highlighted.count * lineHeight}px`,
      "--docs-highlight-offset": `${(highlighted.first - 1) * lineHeight}px`
    })
  } as CSSProperties
  const source = textFrom(children).trimEnd()
  useLayoutEffect(() => {
    if (!hasHighlight) return
    const root = codeRoot.current
    const pre = root?.querySelector("pre")
    const code = pre?.querySelector("code")
    if (root === null || root === undefined || pre === null || pre === undefined || code === null || code === undefined) return
    const position = (): void => {
      const panel = root.closest<HTMLElement>(".docs-code-files-panel")
      if (panel?.hidden) return
      const lines = code.textContent?.split("\n") ?? []
      const target = lines[highlightedLine - 1]
      if (target === undefined) return
      const lineStart = lines.slice(0, highlightedLine - 1).reduce((length, line) => length + line.length + 1, 0)
      const startOffset = lineStart + globalThis.Math.max(0, target.search(/\S/))
      const endOffset = lines.slice(0, highlightedLine - 1 + highlightedCount).join("\n").length
      const range = document.createRange()
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      let offset = 0
      let started = false
      let node = walker.nextNode()
      while (node !== null) {
        const length = node.textContent?.length ?? 0
        if (!started && startOffset < offset + length) {
          range.setStart(node, startOffset - offset)
          started = true
        }
        if (started && endOffset <= offset + length) {
          range.setEnd(node, endOffset - offset)
          break
        }
        offset += length
        node = walker.nextNode()
      }
      if (!started || node === null) return
      const rects = Array.from(range.getClientRects()).filter(rect => rect.height > 0)
      const first = rects[0]
      const last = rects[rects.length - 1]
      if (first === undefined || last === undefined) return
      const preRect = pre.getBoundingClientRect()
      const scale = pre.offsetHeight === 0 ? 1 : preRect.height / pre.offsetHeight
      const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight)
      const leading = (lineHeight - first.height / scale) / 2
      const top = (first.top - preRect.top) / scale - leading
      const height = (last.bottom - first.top) / scale + leading * 2
      root.style.setProperty("--docs-highlight-position", `${top}px`)
      root.style.setProperty("--docs-highlight-height", `${height}px`)
      if (!initiallyScrolled.current && panel !== null && panel.clientHeight > 0) {
        panel.scrollTop += (first.top - panel.getBoundingClientRect().top) / scale - panel.clientHeight * 0.4
        initiallyScrolled.current = true
      }
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(pre)
    let active = true
    void document.fonts.ready.then(() => {
      if (active) position()
    })
    return () => {
      active = false
      observer.disconnect()
    }
  }, [source, hasHighlight, highlightedLine, highlightedCount])
  if (variant === "single") {
    return (
      <div className="install-command docs-code-single" aria-label={`${language} command`}>
        <span aria-hidden="true">$</span>
        {children}
        <button type="button" aria-label={copied ? "Code copied" : "Copy code"} title={copied ? "Copied" : "Copy code"} onClick={() => void copy(source)}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    )
  }
  if (variant === "diagram") {
    return <div className="docs-text-diagram"><pre {...props}>{children}</pre></div>
  }
  return (
    <div ref={codeRoot} className="concept-code docs-code" data-expanded={collapsed ? opened : expanded} data-collapsible={collapsed || undefined} data-highlight={hasHighlight ? "true" : undefined} style={codeStyle}>
      <div className="docs-code-header"><span>{title ?? (language === "ts" || language === "typescript" ? "TypeScript" : language)}</span></div>
      <div className="docs-code-body" id={bodyId}><pre {...props}>{children}</pre></div>
      {collapsed && <button className="docs-code-toggle" type="button" aria-expanded={opened} aria-controls={bodyId} onClick={() => setOpened(value => !value)}>
        {opened ? "Collapse code" : "Expand code"}<ChevronIcon />
      </button>}
      <button type="button" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy(source)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

export const InlineCode = ({ className, ...props }: ComponentPropsWithoutRef<"code">): ReactElement => {
  const block = className?.split(" ").some((name) => name === "hljs" || name.startsWith("language-")) ?? false
  return <code className={`${className ?? ""}${block ? "" : " docs-inline-code"}`.trim()} {...props} />
}
