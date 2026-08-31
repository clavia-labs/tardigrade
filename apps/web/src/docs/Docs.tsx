import { MDXProvider } from "@mdx-js/react"
import { cloneElement, Fragment, isValidElement, useEffect, useState, type ComponentPropsWithoutRef, type CSSProperties, type MouseEvent, type ReactElement, type ReactNode } from "react"

import { ActorDiagram } from "../ActorDiagram"
import { ComponentDiagram } from "../ComponentDiagram"
import { MethodDiagram } from "../MethodDiagram"
import { TransitionLoop } from "../TransitionLoop"
import { docAt, docs, type Doc } from "./load"

const CopyIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.8" d="M9 8h9v11H9zM6 16H5V5h9v1" />
  </svg>
)

const CheckIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter" strokeWidth="1.8" d="m5 12.5 4.2 4.2L19 7" />
  </svg>
)

const BulbIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M8.5 15.5A7 7 0 1 1 15.5 15.5C14.6 16.2 14 17 14 18h-4c0-1-.6-1.8-1.5-2.5Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const ChevronIcon = (): ReactElement => (
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6.5 8 3.5 3.5L13.5 8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" /></svg>
)

const useCopiedState = (): readonly [boolean, () => void] => {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const reset = window.setTimeout(() => setCopied(false), 1800)
    return () => window.clearTimeout(reset)
  }, [copied])
  return [copied, () => setCopied(true)]
}

const Command = ({ label, value }: { readonly label?: string; readonly value: string }): ReactElement => {
  const [copied, markCopied] = useCopiedState()
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    markCopied()
  }
  return (
    <div className="guide-command">
      <div className="install-command" aria-label={label ?? value}>
        <span aria-hidden="true">$</span>
        <code>{value}</code>
        <button type="button" aria-label={copied ? "Command copied" : "Copy command"} title={copied ? "Copied" : "Copy command"} onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  )
}

const ProjectTree = ({ children, name, runtime = false }: { readonly children: ReactNode; readonly name: string; readonly runtime?: boolean }): ReactElement => (
  <div className={`guide-scaffold${runtime ? " guide-runtime-store" : ""}`} aria-label={`${name} project structure`}>
    <strong>{name}</strong>
    <ul>{children}</ul>
  </div>
)

const ProjectFile = ({ children, name }: { readonly children: ReactNode; readonly name: string }): ReactElement => (
  <li><code>{name}</code><span /><p>{children}</p></li>
)

const AnnotatedExample = ({ children }: { readonly children: ReactNode }): ReactElement => {
  const [copied, markCopied] = useCopiedState()
  const copy = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    const example = event.currentTarget.closest(".guide-actor-example")
    const code = Array.from(example?.querySelectorAll("pre") ?? []).map((block) => block.textContent ?? "").join("\n\n")
    await navigator.clipboard.writeText(code)
    markCopied()
  }
  return (
    <div className="guide-actor-example">
      <button className="guide-code-copy" type="button" aria-label={copied ? "Actor copied" : "Copy actor"} onClick={(event) => void copy(event)}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {children}
    </div>
  )
}

const AnnotatedCode = ({ children, description, title, tone }: { readonly children: ReactNode; readonly description: string; readonly title: string; readonly tone: string }): ReactElement => (
  <div className="guide-code-row" data-tone={tone}>
    {children}
    <aside><strong>{title}</strong><p>{description}</p></aside>
  </div>
)

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

const highlightedShell = (source: string): ReactNode => {
  let executable = true
  return (source.match(/(?:'[^']*'|"(?:\\.|[^"])*"|\$[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z0-9-]+|\s+|[^\s]+)/g) ?? [source]).map((token, index) => {
    if (/^\s+$/.test(token)) return token
    if (executable) {
      executable = false
      return <span className="docs-shell-command" key={index}>{token}</span>
    }
    if (token.startsWith("-") || token.startsWith("$")) return <span className="docs-shell-flag" key={index}>{token}</span>
    if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) return <span className="docs-shell-string" key={index}>{token}</span>
    return token
  })
}

type CodeProps = ComponentPropsWithoutRef<"pre"> & {
  readonly expanded?: boolean | undefined
  readonly highlight?: number | string | undefined
  readonly variant?: "multi" | "single" | undefined
}

const Code = ({ children, expanded = false, highlight, variant = "multi", ...props }: CodeProps): ReactElement => {
  const [copied, markCopied] = useCopiedState()
  const language = languageOf(children)
  const highlightedLine = Number(highlight)
  const highlightStyle = Number.isInteger(highlightedLine) && highlightedLine > 0
    ? { "--docs-highlight-offset": `${(highlightedLine - 1) * 1.7}em` } as CSSProperties
    : undefined
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(textFrom(children).trimEnd())
    markCopied()
  }
  if (variant === "single") {
    const source = textFrom(children).trimEnd()
    return (
      <div className="install-command docs-code-single" aria-label={`${language} command`}>
        <span aria-hidden="true">$</span>
        {language === "bash" ? <code className="docs-shell-code">{highlightedShell(source)}</code> : children}
        <button type="button" aria-label={copied ? "Code copied" : "Copy code"} title={copied ? "Copied" : "Copy code"} onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    )
  }
  return (
    <div className="concept-code docs-code" data-expanded={expanded} data-highlight={highlightStyle === undefined ? undefined : "true"} style={highlightStyle}>
      <div className="docs-code-header"><span>{language}</span></div>
      <pre {...props}>{children}</pre>
      <button type="button" aria-label={copied ? "Code copied" : "Copy code"} onClick={() => void copy()}>
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
  if (Array.isArray(node)) return node.map(withFileIcons)
  if (!isValidElement<{ readonly children?: ReactNode }>(node)) return node
  if (node.type === InlineCode) {
    const name = textFrom(node.props.children)
    return cloneElement(node, undefined, <><FileIcon kind={fileIconKindOf(name)} />{node.props.children}</>)
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

const Tip = ({ children, title }: { readonly children: ReactNode; readonly title: string }): ReactElement => (
  <details className="docs-tip">
    <summary><BulbIcon /><span>{title}</span><ChevronIcon /></summary>
    <div className="docs-tip-content">{children}</div>
  </details>
)

const MoonIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>
)

const SunIcon = (): ReactElement => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></svg>
)

const ThemeToggle = (): ReactElement => {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === "dark")
  const toggle = (): void => {
    const nextDark = !dark
    const theme = nextDark ? "dark" : "light"
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem("tardigrade-theme", theme)
    setDark(nextDark)
  }
  return (
    <button className="theme-toggle" type="button" aria-label={`Use ${dark ? "light" : "dark"} mode`} aria-pressed={dark} onClick={toggle}>
      {dark ? <SunIcon /> : <MoonIcon />}
      <span>{dark ? "Light mode" : "Dark mode"}</span>
    </button>
  )
}

const RlmDiagram = (): ReactElement => (
  <div className="rlm-diagram" role="img" aria-label="A long context enters a code environment that makes recursive model calls and returns a final answer">
    <div className="rlm-context-card"><span>context as data</span><div aria-hidden="true"><i /><i /><i /><i /><i /></div><code>context[0..n]</code></div>
    <div className="rlm-diagram-arrow" aria-hidden="true" />
    <div className="rlm-program-card"><span>code environment</span><code>inspect(context)</code><code>partition(context)</code><strong>recursive model calls</strong><div className="rlm-subcalls" aria-hidden="true"><i>LM 01</i><i>LM 02</i><i>LM 03</i></div></div>
    <div className="rlm-diagram-arrow" aria-hidden="true" />
    <div className="rlm-answer-card"><span>result</span><strong>final answer</strong></div>
  </div>
)

const components = {
  ActorDiagram,
  AnnotatedCode,
  AnnotatedExample,
  Command,
  ComponentDiagram,
  ConceptInterface,
  ConceptSection,
  EventLog,
  Filesystem,
  MethodDiagram,
  ProjectFile,
  ProjectTree,
  RlmDiagram,
  Tip,
  TransitionLoop,
  a: (props: ComponentPropsWithoutRef<"a">) => <a {...props} />,
  code: InlineCode,
  pre: Code
}

const CopyMarkdownButton = ({ markdown }: { readonly markdown: string }): ReactElement => {
  const [copied, markCopied] = useCopiedState()
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(markdown)
    markCopied()
  }
  return (
    <button className="copy-markdown" type="button" aria-label={copied ? "Markdown copied" : "Copy page as Markdown"} onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy MD"}</span>
    </button>
  )
}

const Sidebar = ({ current }: { readonly current: Doc }): ReactElement => {
  const sections = docs.reduce<Map<string, Array<Doc>>>((grouped, doc) => {
    const pages = grouped.get(doc.frontmatter.section) ?? []
    pages.push(doc)
    grouped.set(doc.frontmatter.section, pages)
    return grouped
  }, new Map())
  return (
    <aside className="guide-sidebar">
      {[...sections.entries()].map(([section, pages], sectionIndex) => (
        <Fragment key={section}>
          <span className={sectionIndex === 0 ? undefined : "guide-sidebar-section"}>{section}</span>
          {pages.map((page) => <a href={page.frontmatter.route} aria-current={page === current ? "page" : undefined} key={page.frontmatter.route}>{page.frontmatter.title}</a>)}
        </Fragment>
      ))}
      <ThemeToggle />
    </aside>
  )
}

export const DocsPage = ({ pathname }: { readonly pathname: string }): ReactElement | undefined => {
  const doc = docAt(pathname)
  if (doc === undefined) return undefined
  const { Content, frontmatter, markdown } = doc
  return (
    <main className="guide-page">
      <div className="guide-shell">
        <Sidebar current={doc} />
        <article className={`guide-article${frontmatter.articleClass === undefined ? "" : ` ${frontmatter.articleClass}`}`}>
          <div className="guide-heading">
            <div><h1>{frontmatter.title}</h1><p className="guide-intro">{frontmatter.description}</p></div>
            <CopyMarkdownButton markdown={markdown} />
          </div>
          <div className="guide-divider" />
          <MDXProvider components={components}><Content /></MDXProvider>
        </article>
      </div>
    </main>
  )
}
