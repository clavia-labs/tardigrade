import { useEffect, useState, type ReactElement, type RefObject } from "react"

type Heading = { readonly id: string; readonly text: string; readonly level: 2 | 3 }

// HEADING_GAP is the space, in CSS pixels, between the sticky header and the top of a heading's letters after a jump.
export const HEADING_GAP = 24

// alignHeading sets the heading's scroll margin so any scroll to it, by click, hash link, or the router, lands its letters HEADING_GAP below the sticky header; the margin discounts the padding and half-leading above the text, so headings of any size and section headings with a divider land alike.
const alignHeading = (heading: HTMLElement): void => {
  const header = document.querySelector(".site-header")?.getBoundingClientRect().height ?? 0
  const range = document.createRange()
  range.selectNodeContents(heading)
  const line = range.getClientRects()[0] ?? heading.getBoundingClientRect()
  const fontSize = Number.parseFloat(getComputedStyle(heading).fontSize)
  const aboveLetters = line.top - heading.getBoundingClientRect().top + Math.max(0, (line.height - fontSize) / 2)
  heading.style.scrollMarginTop = `${header + HEADING_GAP - aboveLetters}px`
}

// NotesOutline lists the article's h2 and h3 headings and marks the one the reader is in; heading ids come from rehype-slug.
export const NotesOutline = ({ article }: { readonly article: RefObject<HTMLElement | null> }): ReactElement | null => {
  const [headings, setHeadings] = useState<ReadonlyArray<Heading>>([])
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const root = article.current
    if (root === null) return
    const nodes = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]"))
    setHeadings(nodes.map((node) => ({ id: node.id, text: node.textContent ?? "", level: node.tagName === "H2" ? 2 : 3 })))
    // The active heading is the last one whose top has passed a line just below the landing position of a jump.
    const update = (): void => {
      const line = (document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0) + HEADING_GAP + 40
      const passed = nodes.filter((node) => node.getBoundingClientRect().top <= line)
      setActive(passed.at(-1)?.id ?? nodes[0]?.id ?? null)
    }
    // Pad the article's end just enough that every heading can scroll to its landing position; the CSS bottom padding is the floor.
    const align = (): void => nodes.forEach(alignHeading)
    const reserve = (): void => {
      root.style.paddingBottom = ""
      const last = nodes.at(-1)
      if (last === undefined) return
      const header = document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0
      const landing = window.scrollY + last.getBoundingClientRect().top - Number.parseFloat(last.style.scrollMarginTop || "0")
      const deficit = landing - (document.documentElement.scrollHeight - window.innerHeight)
      if (deficit > 0) root.style.paddingBottom = `${Number.parseFloat(getComputedStyle(root).paddingBottom) + deficit}px`
    }
    align()
    reserve()
    // Images and diagrams settle after mount; the observer watches the content box, so the padding it sets does not retrigger it.
    const observer = new ResizeObserver(() => { align(); reserve() })
    observer.observe(root)
    update()
    const linked = window.location.hash === "" ? null : document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
    if (linked !== null && nodes.includes(linked as HTMLHeadingElement)) linked.scrollIntoView({ block: "start" })
    window.addEventListener("scroll", update, { passive: true })
    const onResize = (): void => { align(); reserve(); update() }
    window.addEventListener("resize", onResize)
    return () => {
      window.removeEventListener("scroll", update)
      window.removeEventListener("resize", onResize)
      observer.disconnect()
      root.style.paddingBottom = ""
      nodes.forEach((node) => { node.style.scrollMarginTop = "" })
    }
  }, [article])

  if (headings.length === 0) return null
  return (
    <nav className="notes-outline" aria-label="On this note">
      <p className="notes-outline-title">On this note</p>
      <ol>
        {headings.map((heading) => (
          <li key={heading.id} data-level={heading.level}>
            <a
              href={`#${heading.id}`}
              aria-current={active === heading.id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault()
                document.getElementById(heading.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
                history.replaceState(null, "", `#${heading.id}`)
              }}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
