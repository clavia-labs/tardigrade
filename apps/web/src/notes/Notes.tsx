import { MDXProvider } from "@mdx-js/react"
import { ArrowLeft } from "@phosphor-icons/react"
import { Link } from "@tanstack/react-router"
import { useRef, type ReactElement } from "react"

import Content, { frontmatter } from "@notes/telling-forms-from-the-shadows.mdx"
import markdown from "@notes/telling-forms-from-the-shadows.mdx?doc-source"
import { PageActions } from "../ui/PageActions"
import { AuthorAvatar } from "./AuthorAvatar"
import { NotesCode } from "./NotesCode"
import { NotesLink } from "./NotesLink"
import { NotesOutline } from "./NotesOutline"
import { AgentViewDiagram } from "./diagrams/AgentViewDiagram"
import { CaveDiagram } from "./diagrams/CaveDiagram"
import { CaveStamp } from "./diagrams/CaveStamp"
import { FlyingTardie } from "./diagrams/FlyingTardie"
import { MergeDiagram } from "./diagrams/MergeDiagram"
import { RussianDollDiagram } from "./diagrams/RussianDollDiagram"
import { ShadowDiagram } from "./diagrams/ShadowDiagram"

export const post = frontmatter as {
  readonly title: string
  readonly draft?: boolean
  readonly date: string
  readonly author: string
  readonly authorUrl?: string
  readonly description: string
  readonly route: "/notes/telling-forms-from-the-shadows"
  readonly socialImage: string
  readonly socialImageAlt: string
}

const postDate = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(new Date(post.date))

export const NotesPage = (): ReactElement => (
  <main className="notes-index" aria-label="Notes">
    <div className="notes-index-inner">
      <article className="notes-entry">
        <div>
          <h2><Link to={post.route}>{post.title}</Link>{post.draft === true ? <span className="notes-draft">[DRAFT]</span> : null}</h2>
          <time dateTime={post.date}>{postDate}</time>
        </div>
        <CaveStamp />
      </article>
    </div>
  </main>
)

export const NotesPostPage = (): ReactElement => {
  const article = useRef<HTMLElement>(null)
  return (
  <main className="guide-page notes-layout">
    <article className="guide-article notes-article" ref={article}>
      <div className="notes-toolbar">
        <Link className="notes-back" to="/notes"><ArrowLeft size={16} aria-hidden="true" />Back to Notes</Link>
        <PageActions markdown={markdown} contentType="note" />
      </div>
      <h1>{post.title}{post.draft === true ? <span className="notes-draft">[DRAFT]</span> : null}</h1>
      <div className="notes-metadata"><time dateTime={post.date}>{postDate}</time></div>
      <div className="guide-divider" />
      <MDXProvider components={{ a: NotesLink, pre: NotesCode, AuthorAvatar, AgentViewDiagram, CaveDiagram, FlyingTardie, MergeDiagram, RussianDollDiagram, ShadowDiagram }}><Content /></MDXProvider>
    </article>
    <aside className="notes-outline-rail"><NotesOutline article={article} /></aside>
  </main>
  )
}
