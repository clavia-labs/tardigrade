import { MDXProvider } from "@mdx-js/react"
import { ArrowUpRight } from "@phosphor-icons/react"
import type { ReactElement } from "react"
import { mdxComponents } from "./components"
import { DEFAULT_DOC_ROUTE, docAt } from "./load"
import { Sidebar } from "./Sidebar"

export const DocsPage = ({ pathname }: { readonly pathname: string }): ReactElement | undefined => {
  const doc = docAt(pathname)
  if (doc === undefined) return undefined
  const { Content, frontmatter } = doc
  const introduction = frontmatter.route === DEFAULT_DOC_ROUTE
  return <main className="guide-page">
    <div className="guide-shell">
      <Sidebar current={doc} />
      <article className={`guide-article${introduction ? " introduction-article" : ""}${frontmatter.articleClass === undefined ? "" : ` ${frontmatter.articleClass}`}`}>
        {introduction ? null : <div className="guide-heading"><div><h1>{frontmatter.title}</h1>{frontmatter.hideDescription === true ? null : <p className="guide-intro">{frontmatter.description}</p>}</div></div>}
        <MDXProvider components={mdxComponents}><Content /></MDXProvider>
        {introduction ? <footer className="introduction-footer">
          <p>Tardigrade is <a href="https://github.com/clavia-labs/tardigrade" target="_blank" rel="noreferrer">open source</a> under the <a href="https://github.com/clavia-labs/tardigrade/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT license</a>.</p>
          <a className="introduction-credit" href="https://github.com/clavia-labs" target="_blank" rel="noreferrer"><span>by</span> Clavia Labs</a>
        </footer> : <div className="docs-page-footer"><a href={`https://github.com/clavia-labs/tardigrade/blob/main/docs/${doc.source}`} target="_blank" rel="noreferrer">Edit this page <ArrowUpRight aria-hidden="true" /></a></div>}
      </article>
    </div>
  </main>
}
