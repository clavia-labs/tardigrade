import { MDXProvider } from "@mdx-js/react"
import { Link } from "@tanstack/react-router"
import { Fragment, type ReactElement } from "react"

import { CheckIcon, CopyIcon, mdxComponents, useCopiedState } from "./components"
import { docAt, docs, type Doc } from "./load"

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
          {pages.map((page) => <Link to="/docs/$" params={{ _splat: page.frontmatter.route.slice("/docs/".length) }} aria-current={page === current ? "page" : undefined} key={page.frontmatter.route}>{page.frontmatter.title}</Link>)}
        </Fragment>
      ))}
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
          <MDXProvider components={mdxComponents}><Content /></MDXProvider>
        </article>
      </div>
    </main>
  )
}
