import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react"

type Segment = { readonly text: string; readonly struck: boolean }
type Heading = { readonly id: string; readonly segments: ReadonlyArray<Segment>; readonly level: 2 | 3 | 4 }

// segmentsOf keeps a heading's strikethrough, so a struck word reads as struck in the outline too; other inline markup flattens to text.
const segmentsOf = (heading: HTMLElement): ReadonlyArray<Segment> => Array.from(heading.childNodes, (child) => ({
  text: child.textContent ?? "",
  struck: child instanceof HTMLElement && (child.tagName === "DEL" || child.tagName === "S"),
})).filter((segment) => segment.text !== "")

// HEADING_GAP is the space, in CSS pixels, between the sticky header and the top of a heading's letters after a jump.
const HEADING_GAP = 24

// readingLine is the viewport y a heading's top must pass to become active: just below where a jump lands it.
const readingLine = (): number => (document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0) + HEADING_GAP + 40

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

// RAIL_X is the rail's resting x, in CSS pixels, inside the ink SVG; the SVG sits so this lands on the outline's left edge.
const RAIL_X = 6
// RAIL_WOBBLE is the rail's peak sideways drift, in CSS pixels, which gives it the hand-drawn look.
const RAIL_WOBBLE = 2.4
// RAIL_STEP is the vertical spacing, in CSS pixels, of the points the rail is drawn through.
const RAIL_STEP = 2
// STOP_GAP is the distance, in CSS pixels, the rail runs past the last outline row; the pen comes to rest there as a full stop at the end of the note.
const STOP_GAP = 14
// ROW_MARK is the offset, in CSS pixels, from a row's top to the point on the rail the pen rests at while that heading is active.
const ROW_MARK = 14
// PEN_EASE is the time constant, in milliseconds, of the pen's glide toward its scroll position; reduced motion skips the glide.
const PEN_EASE = 90

type Rail = { readonly d: string; readonly height: number; readonly xs: ReadonlyArray<number>; readonly lengths: ReadonlyArray<number> }

// wobble sums two sines of unrelated period so the drift never visibly repeats down a long outline.
const wobble = (y: number): number => RAIL_WOBBLE * (0.65 * Math.sin(y / 23 + 1.3) + 0.35 * Math.sin(y / 8.9 + 0.4))

// drawRail samples the rail every RAIL_STEP pixels and keeps each sample's arc length, so the pen and trail can be placed by height.
const drawRail = (height: number): Rail => {
  const xs: Array<number> = []
  const lengths: Array<number> = []
  for (let i = 0; i * RAIL_STEP <= height + RAIL_STEP; i++) {
    const y = Math.min(i * RAIL_STEP, height)
    xs.push(RAIL_X + wobble(y))
    lengths.push(i === 0 ? 0 : lengths[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, y - Math.min((i - 1) * RAIL_STEP, height)))
    if (y === height) break
  }
  const d = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${Math.min(i * RAIL_STEP, height).toFixed(2)}`).join("")
  return { d, height, xs, lengths }
}

// sample reads a per-sample series at height y by linear interpolation between neighbouring samples.
const sample = (series: ReadonlyArray<number>, y: number): number => {
  const at = Math.max(0, y) / RAIL_STEP
  const i = Math.min(Math.floor(at), series.length - 1)
  const j = Math.min(i + 1, series.length - 1)
  return series[i]! + (series[j]! - series[i]!) * (at - i)
}

// NotesOutline lists the article's h2, h3, and h4 headings and marks the one the reader is in; heading ids come from rehype-slug.
export const NotesOutline = ({ article }: { readonly article: RefObject<HTMLElement | null> }): ReactElement | null => {
  const [headings, setHeadings] = useState<ReadonlyArray<Heading>>([])
  const [active, setActive] = useState<string | null>(null)
  const [rail, setRail] = useState<Rail | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const trail = useRef<SVGPathElement>(null)
  const pen = useRef<SVGCircleElement>(null)

  useEffect(() => {
    const root = article.current
    if (root === null) return
    const nodes = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id], h4[id]"))
    setHeadings(nodes.map((node) => ({ id: node.id, segments: segmentsOf(node), level: node.tagName === "H2" ? 2 : node.tagName === "H3" ? 3 : 4 })))
    // The active heading is the last one whose top has passed a line just below the landing position of a jump.
    const update = (): void => {
      const line = readingLine()
      const passed = nodes.filter((node) => node.getBoundingClientRect().top <= line)
      setActive(passed.at(-1)?.id ?? nodes[0]?.id ?? null)
    }
    // Pad the article's end just enough that every heading can scroll to its landing position; the CSS bottom padding is the floor.
    const align = (): void => nodes.forEach(alignHeading)
    const reserve = (): void => {
      root.style.paddingBottom = ""
      const last = nodes.at(-1)
      if (last === undefined) return
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

  // The pen sits at the active row when its heading crosses the reading line, moves between rows in step with the scroll between headings, and comes to rest at the rail's end at the bottom of the page.
  useEffect(() => {
    const root = article.current
    const ol = list.current
    if (root === null || ol === null || headings.length === 0) return
    const nodes = headings.map((heading) => document.getElementById(heading.id)).filter((node) => node !== null)
    let drawn: Rail | null = null
    const measure = (): void => {
      drawn = drawRail(ol.offsetHeight + STOP_GAP)
      setRail(drawn)
    }
    let frame = 0
    let shown: number | null = null
    let last = 0
    const still = window.matchMedia("(prefers-reduced-motion: reduce)")
    // Marks pair a scroll position with a rail height; a heading's mark is the scroll at which its top meets the reading line, the same test that makes it active, so the pen reaches a row exactly when its heading is marked.
    const place = (now: number): void => {
      frame = 0
      if (drawn === null || trail.current === null || pen.current === null) return
      const rows = Array.from(ol.children, (row) => (row as HTMLElement).offsetTop + ROW_MARK)
      const line = readingLine()
      const scroll = Math.max(window.scrollY, 0)
      const headingMarks = nodes.map((node, i) => [scroll + node.getBoundingClientRect().top - line, rows[i] ?? 0] as const)
      const end = Math.max(document.documentElement.scrollHeight - window.innerHeight, (headingMarks.at(-1)?.[0] ?? 0) + 1)
      let floor = 0
      const steps = [[0, 0] as const, ...headingMarks, [end, drawn.height] as const].map(([at, row]) => { floor = Math.max(at, floor); return [floor, row] as const })
      let y = drawn.height
      for (let i = 1; i < steps.length; i++) {
        const [from, fromY] = steps[i - 1]!
        const [to, toY] = steps[i]!
        if (scroll >= to) continue
        y = fromY + (toY - fromY) * ((scroll - from) / (to - from))
        break
      }
      const target = Math.min(Math.max(y, 0), drawn.height)
      // The pen closes a fixed fraction of the remaining distance per unit time, so a short section's bend reads as a glide instead of a jump; the first placement snaps.
      y = shown === null || still.matches ? target : target + (shown - target) * Math.exp(-(now - last) / PEN_EASE)
      if (Math.abs(target - y) < 0.1) y = target
      shown = y
      last = now
      if (y !== target) frame = requestAnimationFrame(place)
      const total = drawn.lengths.at(-1) ?? 0
      const inked = sample(drawn.lengths, y)
      // A zero-length dash still paints its round caps, so an empty trail is hidden outright; the gap of twice the length keeps the dash pattern from repeating onto the path.
      trail.current.style.strokeDashoffset = `${total - inked}`
      trail.current.style.visibility = inked < 0.5 ? "hidden" : "visible"
      pen.current.setAttribute("cx", sample(drawn.xs, y).toFixed(2))
      pen.current.setAttribute("cy", y.toFixed(2))
    }
    const schedule = (): void => {
      if (frame !== 0) return
      // After an idle stretch the glide resumes from one frame ago, so the first step is a frame's worth of easing.
      frame = requestAnimationFrame((now) => { last = Math.max(last, now - 16); place(now) })
    }
    measure()
    // The rail is redrawn only when the outline's height changes; any layout shift in the article moves the pen.
    const observer = new ResizeObserver((entries) => {
      if (entries.some((entry) => entry.target === ol)) measure()
      schedule()
    })
    observer.observe(ol)
    observer.observe(root)
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [article, headings])

  if (headings.length === 0) return null
  return (
    <nav className="notes-outline" aria-label="On this note">
      <p className="notes-outline-title">On this note</p>
      <div className="notes-outline-track">
        <svg className="notes-outline-ink" width={RAIL_X * 2} height={rail?.height ?? 0} aria-hidden="true">
          <path className="base" d={rail?.d} />
          <path ref={trail} className="trail" d={rail?.d} style={{ strokeDasharray: `${rail?.lengths.at(-1) ?? 0} ${2 * (rail?.lengths.at(-1) ?? 0)}`, strokeDashoffset: rail?.lengths.at(-1) ?? 0, visibility: "hidden" }} />
          <circle ref={pen} className="pen" cx={RAIL_X} cy={0} r={3} />
        </svg>
        <ol ref={list}>
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
                {heading.segments.map((segment, i) => segment.struck ? <del key={i}>{segment.text}</del> : segment.text)}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  )
}
