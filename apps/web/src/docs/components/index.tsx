import { SearchToolStateDiagram } from "./diagrams/SearchToolStateDiagram"
import { ComponentAnatomyDiagram } from "./diagrams/ComponentAnatomyDiagram"
import { ComponentOverviewDiagram } from "./diagrams/ComponentOverviewDiagram"
import { WorldEffectDiagram } from "./diagrams/WorldEffectDiagram"
import { ComponentCycleDiagram } from "./diagrams/ComponentCycleDiagram"
import { AgentProjectionDiagram } from "./diagrams/AgentProjectionDiagram"
import { StateSnapshotDiagram } from "./diagrams/StateSnapshotDiagram"
import { StateSpaceSamplingDiagram } from "./diagrams/StateSpaceSamplingDiagram"
import { AgentCompositionDiagram } from "./diagrams/AgentCompositionDiagram"
import { ComponentCompositionDiagram } from "./diagrams/ComponentCompositionDiagram"
import { StateComplexityIllustration } from "./diagrams/StateComplexityIllustration"
import { StateExplosionDiagram } from "./diagrams/StateExplosionDiagram"
import { AgentStateMachineDiagram } from "./diagrams/AgentStateMachineDiagram"
import { FactoryCounterexampleDiagram } from "./diagrams/FactoryCounterexampleDiagram"
import { FactoryDiversionDiagram } from "./diagrams/FactoryDiversionDiagram"
import { VerificationResultsDiagram } from "./diagrams/VerificationResultsDiagram"
import { FactoryPathGenerator } from "./diagrams/FactoryPathGenerator"
import { ClippieToolsDiagram } from "./diagrams/ClippieToolsDiagram"
import { FactoryToolsDiagram } from "./diagrams/FactoryPathsDiagram"
import { PaperclipProblemDiagram } from "./diagrams/PaperclipProblemDiagram"
import { VerificationPathsDiagram } from "./diagrams/VerificationPathsDiagram"
import { TrafficLightDiagram } from "./diagrams/TrafficLightDiagram"
import { ShipPositionDiagram } from "./diagrams/ShipPositionDiagram"
import { ProjectionFlowDiagram } from "./diagrams/ProjectionFlowDiagram"
import { AgentTrajectoryDiagram } from "./diagrams/AgentTrajectoryDiagram"
import { Children, cloneElement, isValidElement, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactElement, type ReactNode } from "react"
import { renderToString } from "katex"

import { CheckIcon, CopyIcon, useCopy } from "../../ui/copy"
import { ActorDiagram } from "./diagrams/ActorDiagram"
import { PeopleTalkingDiagram } from "./diagrams/PeopleTalkingDiagram"
import { ActorCommunicationDiagram } from "./diagrams/ActorCommunicationDiagram"
import { ActorInstancesDiagram } from "./diagrams/ActorInstancesDiagram"
import { ChildThreadsDiagram } from "./diagrams/ChildThreadsDiagram"
import { HostLayersDiagram } from "./diagrams/HostLayersDiagram"
import { ThreadInvocationDiagram } from "./diagrams/ThreadInvocationDiagram"
import { ThreadResolutionDiagram } from "./diagrams/ThreadResolutionDiagram"
import { BehaviorTrajectoryDiagram } from "./diagrams/BehaviorTrajectoryDiagram"
import { ComponentDiagram } from "./diagrams/ComponentDiagram"
import { CompactionMachineDiagram } from "./diagrams/CompactionMachineDiagram"
import { ComposableHarnessDiagram } from "./diagrams/ComposableHarnessDiagram"
import { ForkingDiagram } from "./diagrams/ForkingDiagram"
import { HarnessDiagram } from "./diagrams/HarnessDiagram"
import { InterfaceComparisonDiagram } from "./diagrams/InterfaceComparisonDiagram"
import { InfiniteMemoryDiagram } from "./diagrams/InfiniteMemoryDiagram"
import { LetItCrashDiagram } from "./diagrams/LetItCrashDiagram"
import { MethodDiagram } from "./diagrams/MethodDiagram"
import { PrimitiveDiagram } from "./diagrams/PrimitiveDiagram"
import { RlmDiagram } from "./diagrams/RlmDiagram"
import { ServerlessDiagram } from "./diagrams/ServerlessDiagram"
import { TrajectoryBranchesDiagram } from "./diagrams/TrajectoryBranchesDiagram"
import { TransitionLoop } from "./diagrams/TransitionLoop"
import { TypedEffectDiagram } from "./diagrams/TypedEffectDiagram"

const BulbIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.5 15.5A7 7 0 1 1 15.5 15.5C14.6 16.2 14 17 14 18h-4c0-1-.6-1.8-1.5-2.5Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const ChevronIcon = (): ReactElement => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></svg>
)

const InlineMine = (): ReactElement => (
  <svg className="docs-inline-mine" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect className="verification-tile" data-kind="unsafe" x="1" y="1" width="22" height="22" />
    <path className="verification-tile-light" d="M2 22V2h20l-3 3H5v14Z" />
    <path className="verification-tile-shadow" d="M2 22h20V2l-3 3v14H5Z" />
    <g className="verification-tile-mark" transform="translate(12 12) scale(.7)">
      <path d="M0-7v14M-7 0H7M-5-5 5 5M5-5-5 5" />
      <circle className="verification-mine" r="4.5" />
      <rect className="verification-mine-glint" x="-2" y="-2" width="2" height="2" />
    </g>
  </svg>
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

type CodeFileProps = { readonly name: string; readonly children: ReactNode }
const CodeFile = ({ children }: CodeFileProps): ReactElement => <>{children}</>
const CodeFiles = ({ children, selected }: { readonly children: ReactNode; readonly selected?: string }): ReactElement => {
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

const Code = ({ children, expanded = false, collapsed = false, highlight, variant = "multi", ...props }: CodeProps): ReactElement => {
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
      <div className="docs-code-header"><span>{language}</span></div>
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
    const description = children.slice(fileIndex + 1).filter((child) => !isValidElement(child) || child.type !== "ul")
    const nestedLists = children.slice(fileIndex + 1).filter((child) => isValidElement(child) && child.type === "ul")
    return cloneElement(node, undefined,
      <div className="docs-filesystem-row">
        <FileIcon kind={fileIconKindOf(name)} />
        <div className="docs-filesystem-entry">
          {file}
          {textFrom(description).trim() ? <span className="docs-filesystem-description">{description}</span> : null}
        </div>
      </div>,
      withFileIcons(nestedLists)
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

const Link = ({ href, ...props }: ComponentPropsWithoutRef<"a">): ReactElement => {
  const external = href?.startsWith("https://") === true || href?.startsWith("http://") === true
  return <a href={href} {...props} {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})} />
}

export const mdxComponents = {
  SearchToolStateDiagram,
  ComponentAnatomyDiagram,
  ComponentOverviewDiagram,
  WorldEffectDiagram,
  ComponentCycleDiagram,
  AgentProjectionDiagram,
  StateSnapshotDiagram,
  StateSpaceSamplingDiagram,
  AgentCompositionDiagram,
  ComponentCompositionDiagram,
  StateComplexityIllustration,
  StateExplosionDiagram,
  AgentStateMachineDiagram,
  VerificationPathsDiagram,
  InlineMine,
  PaperclipProblemDiagram,
  FactoryToolsDiagram,
  ClippieToolsDiagram,
  FactoryPathGenerator,
  VerificationResultsDiagram,
  FactoryCounterexampleDiagram,
  FactoryDiversionDiagram,
  CodeFiles,
  CodeFile,
  TrafficLightDiagram,
  ShipPositionDiagram,
  ProjectionFlowDiagram,
  AgentTrajectoryDiagram,
  ActorDiagram,
  ActorInstancesDiagram,
  ActorCommunicationDiagram,
  PeopleTalkingDiagram,
  ChildThreadsDiagram,
  ThreadInvocationDiagram,
  HostLayersDiagram,
  ThreadResolutionDiagram,
  BehaviorTrajectoryDiagram,
  Command,
  ComponentDiagram,
  CompactionMachineDiagram,
  ComposableHarnessDiagram,
  ConceptInterface,
  ConceptSection,
  EventLog,
  Filesystem,
  ForkingDiagram,
  HarnessDiagram,
  InterfaceComparisonDiagram,
  InfiniteMemoryDiagram,
  LetItCrashDiagram,
  Math,
  MethodDiagram,
  PrimitiveDiagram,
  RlmDiagram,
  ServerlessDiagram,
  Tip,
  TrajectoryBranchesDiagram,
  TransitionLoop,
  TypedEffectDiagram,
  a: Link,
  code: InlineCode,
  table: ({ children, ...props }: ComponentPropsWithoutRef<"table">) => (
    <div className="docs-table"><table {...props}>{children}</table></div>
  ),
  pre: Code
}
