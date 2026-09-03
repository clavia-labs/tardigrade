import { Children, cloneElement, isValidElement, useLayoutEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { renderToString } from "katex"

import { CheckIcon, CopyIcon, useCopy } from "../../ui/copy"
import { ActorDiagram } from "./diagrams/ActorDiagram"
import { BehaviorTrajectoryDiagram } from "./diagrams/BehaviorTrajectoryDiagram"
import { ComponentDiagram } from "./diagrams/ComponentDiagram"
import { CompactionMachineDiagram } from "./diagrams/CompactionMachineDiagram"
import { HarnessDiagram } from "./diagrams/HarnessDiagram"
import { InterfaceComparisonDiagram } from "./diagrams/InterfaceComparisonDiagram"
import { MethodDiagram } from "./diagrams/MethodDiagram"
import { PrimitiveDiagram } from "./diagrams/PrimitiveDiagram"
import { RlmDiagram } from "./diagrams/RlmDiagram"
import { TransitionLoop } from "./diagrams/TransitionLoop"

const BulbIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.5 15.5A7 7 0 1 1 15.5 15.5C14.6 16.2 14 17 14 18h-4c0-1-.6-1.8-1.5-2.5Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const ChevronIcon = (): ReactElement => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></svg>
)

const Command = ({ label, value }: { readonly label?: string; readonly value: string }): ReactElement => {
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

const textFrom = (node: ReactNode): string => {
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
  readonly highlight?: number | string | undefined
  readonly variant?: "diagram" | "multi" | "single" | undefined
}

const Code = ({ children, expanded = false, highlight, variant = "multi", ...props }: CodeProps): ReactElement => {
  const [copied, copy] = useCopy()
  const codeRoot = useRef<HTMLDivElement>(null)
  const language = languageOf(children)
  const lineHeight = 20
  const highlightedLine = Number(highlight)
  const hasHighlight = Number.isInteger(highlightedLine) && highlightedLine > 0
  const codeStyle = {
    "--docs-code-line-height": `${lineHeight}px`,
    ...(hasHighlight ? { "--docs-highlight-offset": `${(highlightedLine - 1) * lineHeight}px` } : {})
  } as CSSProperties
  const source = textFrom(children).trimEnd()
  useLayoutEffect(() => {
    if (!hasHighlight) return
    const root = codeRoot.current
    const pre = root?.querySelector("pre")
    const code = pre?.querySelector("code")
    if (root === null || root === undefined || pre === null || pre === undefined || code === null || code === undefined) return
    const position = (): void => {
      const lines = code.textContent?.split("\n") ?? []
      const target = lines[highlightedLine - 1]
      if (target === undefined) return
      const lineStart = lines.slice(0, highlightedLine - 1).reduce((length, line) => length + line.length + 1, 0)
      const firstContent = target.search(/\S/)
      const targetOffset = lineStart + (firstContent < 0 ? 0 : firstContent)
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      let offset = 0
      let node = walker.nextNode()
      while (node !== null) {
        const text = node.textContent ?? ""
        if (targetOffset < offset + text.length) {
          const range = document.createRange()
          const start = targetOffset - offset
          range.setStart(node, start)
          range.setEnd(node, globalThis.Math.min(start + 1, text.length))
          const character = range.getBoundingClientRect()
          const preRect = pre.getBoundingClientRect()
          const scale = pre.offsetHeight === 0 ? 1 : preRect.height / pre.offsetHeight
          const renderedTop = (character.top - preRect.top) / scale
          const renderedHeight = character.height / scale
          const renderedLineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight)
          root.style.setProperty("--docs-highlight-position", `${renderedTop - (renderedLineHeight - renderedHeight) / 2}px`)
          return
        }
        offset += text.length
        node = walker.nextNode()
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
  }, [children, hasHighlight, highlightedLine])
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
    <div ref={codeRoot} className="concept-code docs-code" data-expanded={expanded} data-highlight={hasHighlight ? "true" : undefined} style={codeStyle}>
      <div className="docs-code-header"><span>{language}</span></div>
      <pre {...props}>{children}</pre>
      <button type="button" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy(source)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  )
}

const InlineCode = ({ className, ...props }: ComponentPropsWithoutRef<"code">): ReactElement => {
  const block = className?.split(" ").some((name) => name === "hljs" || name.startsWith("language-")) ?? false
  return <code className={`${className ?? ""}${block ? "" : " docs-inline-code"}`.trim()} {...props} />
}

type FileIconKind = "database" | "file" | "json" | "typescript"

const fileIconKindOf = (name: string): FileIconKind => {
  if (name.endsWith(".ts")) return "typescript"
  if (name.endsWith(".sqlite") || name.endsWith(".db")) return "database"
  if (/\.jsonc?$/.test(name)) return "json"
  return "file"
}

const FileIcon = ({ kind }: { readonly kind: FileIconKind }): ReactElement => {
  if (kind === "typescript") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5" /><text x="3.4" y="11.8">TS</text></svg>
  if (kind === "database") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5.5" ry="2.2" /><path d="M2.5 3.5v8.8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2V3.5M2.5 8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" /></svg>
  if (kind === "json") return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.5H5.3c-1 0-1.5.5-1.5 1.5v2.1c0 .9-.4 1.4-1.3 1.4.9 0 1.3.5 1.3 1.4V12c0 1 .5 1.5 1.5 1.5h1.2M9.5 2.5h1.2c1 0 1.5.5 1.5 1.5v2.1c0 .9.4 1.4 1.3 1.4-.9 0-1.3.5-1.3 1.4V12c0 1-.5 1.5-1.5 1.5H9.5" /></svg>
  return <svg className="docs-file-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6l4 4v9H3Z" /><path d="M9 1.5v4h4" /></svg>
}

const withFileIcons = (node: ReactNode): ReactNode => {
  if (Array.isArray(node)) return Children.map(node, withFileIcons)
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return node
  if (node.type === "li") {
    const children = Children.toArray(node.props.children)
    const fileIndex = children.findIndex((child) => isValidElement(child) && child.type === InlineCode)
    if (fileIndex === -1) return node
    const file = children[fileIndex] as ReactElement<{ readonly children?: ReactNode }>
    const name = textFrom(file.props.children)
    return cloneElement(node, undefined,
      cloneElement(file, undefined, <><FileIcon kind={fileIconKindOf(name)} />{file.props.children}</>),
      <span className="docs-filesystem-description">{children.slice(fileIndex + 1)}</span>
    )
  }
  return cloneElement(node, undefined, withFileIcons(node.props.children))
}

const Filesystem = ({ children, root }: { readonly children: ReactNode; readonly root: string }): ReactElement => (
  <div className="docs-filesystem" aria-label={`${root} filesystem`}>
    <strong>{root}</strong>
    {withFileIcons(children)}
  </div>
)

const EventLog = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <div className="docs-event-log">{children}</div>
)

const ConceptInterface = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <div className="concept-interface"><span>interface</span>{children}</div>
)

const ConceptSection = ({ children, kind }: { readonly children: ReactNode; readonly kind: string }): ReactElement => (
  <section className={`concept-section concept-section-${kind}`}>{children}</section>
)

const Math = ({ expression }: { readonly expression: string }): ReactElement => (
  <div
    className="docs-math"
    dangerouslySetInnerHTML={{ __html: renderToString(expression, { displayMode: true, throwOnError: false }) }}
  />
)

const Tip = ({ children, title }: { readonly children: ReactNode; readonly title: string }): ReactElement => (
  <details className="docs-tip">
    <summary><BulbIcon /><span>{title}</span><ChevronIcon /></summary>
    <div className="docs-tip-content">{children}</div>
  </details>
)

export const mdxComponents = {
  ActorDiagram,
  BehaviorTrajectoryDiagram,
  Command,
  ComponentDiagram,
  CompactionMachineDiagram,
  ConceptInterface,
  ConceptSection,
  EventLog,
  Filesystem,
  HarnessDiagram,
  InterfaceComparisonDiagram,
  Math,
  MethodDiagram,
  PrimitiveDiagram,
  RlmDiagram,
  Tip,
  TransitionLoop,
  a: (props: ComponentPropsWithoutRef<"a">) => <a {...props} />,
  code: InlineCode,
  pre: Code
}
