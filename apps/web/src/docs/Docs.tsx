import { MDXProvider } from "@mdx-js/react"
import { ArrowSquareOut, CaretDown, ChatCircleDots } from "@phosphor-icons/react"
import { Link } from "@tanstack/react-router"
import { Fragment, useEffect, useRef, useState, type ReactElement } from "react"
import { siClaude, siOpenai } from "simple-icons/icons"

import { CheckIcon, CopyIcon, useCopy } from "../ui/copy"
import { mdxComponents } from "./components"
import { docAt, docSections, type Doc } from "./load"

const CopyMarkdownButton = ({ markdown }: { readonly markdown: string }): ReactElement => {
  const [copied, copy] = useCopy()
  return (
    <button className="copy-markdown" type="button" aria-label={copied ? "Markdown copied" : "Copy page as Markdown"} onClick={() => void copy(markdown)}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy MD"}</span>
    </button>
  )
}

const BrandIcon = ({ path }: { readonly path: string }): ReactElement => (
  <svg className="ask-ai-provider-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={path} /></svg>
)

const assistantPrompt = (markdown: string): string => `Use the following Tardigrade documentation as context. Help me understand or apply it.\n\n<documentation>\n${markdown}\n</documentation>`

const AskAiButton = ({ markdown }: { readonly markdown: string }): ReactElement => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [open])
  const openAssistant = (url: string): void => {
    void navigator.clipboard.writeText(assistantPrompt(markdown))
    window.open(url, "_blank", "noopener,noreferrer")
    setOpen(false)
  }
  return (
    <div className="ask-ai" ref={rootRef}>
      <button className="ask-ai-trigger" type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((current) => !current)}>
        <ChatCircleDots className="ask-ai-trigger-icon" aria-hidden="true" /><span>Ask</span><CaretDown className="ask-ai-trigger-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div className="ask-ai-menu">
          <button type="button" onClick={() => openAssistant("https://chatgpt.com/")}><BrandIcon path={siOpenai.path} /><span><strong>ChatGPT</strong><small>Copy context and open</small></span><ArrowSquareOut aria-hidden="true" /></button>
          <button type="button" onClick={() => openAssistant("https://claude.ai/new")}><BrandIcon path={siClaude.path} /><span><strong>Claude</strong><small>Copy context and open</small></span><ArrowSquareOut aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  )
}

const Sidebar = ({ current }: { readonly current: Doc }): ReactElement => (
  <aside className="guide-sidebar">
    {docSections.map(([section, pages], sectionIndex) => (
      <Fragment key={section}>
        <span className={sectionIndex === 0 ? undefined : "guide-sidebar-section"}>{section}</span>
        {pages.map((page) => <Link to="/docs/$" params={{ _splat: page.frontmatter.route.slice("/docs/".length) }} aria-current={page === current ? "page" : undefined} key={page.frontmatter.route}>{page.frontmatter.title}</Link>)}
      </Fragment>
    ))}
  </aside>
)

export const DocsPage = ({ pathname }: { readonly pathname: string }): ReactElement | undefined => {
  const doc = docAt(pathname)
  if (doc === undefined) return undefined
  const { Content, frontmatter } = doc
  return (
    <main className="guide-page">
      <div className="guide-shell">
        <Sidebar current={doc} />
        <article className={`guide-article${frontmatter.articleClass === undefined ? "" : ` ${frontmatter.articleClass}`}`}>
          <div className="guide-heading">
            <div><h1>{frontmatter.title}</h1>{frontmatter.hideDescription === true ? null : <p className="guide-intro">{frontmatter.description}</p>}</div>
            <div className="guide-heading-actions"><CopyMarkdownButton markdown={doc.markdown} /><AskAiButton markdown={doc.markdown} /></div>
          </div>
          <div className="guide-divider" />
          <MDXProvider components={mdxComponents}><Content /></MDXProvider>
        </article>
      </div>
    </main>
  )
}
