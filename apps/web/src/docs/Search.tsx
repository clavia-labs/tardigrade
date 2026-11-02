import { Link } from "@tanstack/react-router"
import { MagnifyingGlass, X } from "@phosphor-icons/react"
import { useEffect, useRef, useState, type ReactElement } from "react"
import { DEFAULT_DOC_ROUTE, docPages } from "./load"

export const DocSearch = (): ReactElement => {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const matches = docPages.filter(doc => terms.every(term => `${doc.frontmatter.title} ${doc.frontmatter.description} ${doc.markdown}`.toLowerCase().includes(term)))
  const open = () => { dialog.current?.showModal(); input.current?.focus() }
  const close = () => dialog.current?.close()
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); open() }
    }
    document.addEventListener("keydown", keyboard)
    return () => document.removeEventListener("keydown", keyboard)
  }, [])
  return <>
    <button className="docs-search-trigger" type="button" onClick={open}><MagnifyingGlass aria-hidden="true" /><span>Search</span><kbd>⌘ K</kbd></button>
    <dialog className="docs-search-dialog" ref={dialog} onClose={() => setQuery("")} onClick={event => { if (event.target === event.currentTarget) close() }} onKeyDown={event => {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        const links = Array.from(dialog.current?.querySelectorAll<HTMLAnchorElement>(".docs-search-results a") ?? [])
        const current = links.indexOf(document.activeElement as HTMLAnchorElement)
        links[(current + 1) % links.length]?.focus()
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        const links = Array.from(dialog.current?.querySelectorAll<HTMLAnchorElement>(".docs-search-results a") ?? [])
        const current = links.indexOf(document.activeElement as HTMLAnchorElement)
        if (current <= 0) input.current?.focus()
        else links[current - 1]?.focus()
      }
      if (event.key === "Enter" && event.target === input.current) { event.preventDefault(); dialog.current?.querySelector<HTMLAnchorElement>(".docs-search-results a")?.click() }
    }} aria-label="Search documentation">
      <div className="docs-search-field"><MagnifyingGlass aria-hidden="true" /><input ref={input} aria-label="Search documentation" placeholder="Search documentation…" value={query} onChange={event => setQuery(event.target.value)} /><button type="button" onClick={close} aria-label="Close search"><X /></button></div>
      <div className="docs-search-results">
        {matches.length === 0 ? <p>No pages match “{query}”.</p> : matches.map(doc => <Link key={doc.frontmatter.route} to={doc.frontmatter.route === DEFAULT_DOC_ROUTE ? "/" : doc.frontmatter.route} onClick={close}><span>{doc.frontmatter.route === DEFAULT_DOC_ROUTE ? "Introduction" : doc.frontmatter.title}</span><small>{doc.frontmatter.description}</small></Link>)}
      </div>
      <div className="docs-search-hint"><span>↑ ↓ to navigate</span><span>↵ to open</span><span>esc to close</span></div>
    </dialog>
  </>
}
