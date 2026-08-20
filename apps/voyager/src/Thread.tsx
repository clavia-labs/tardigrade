import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react"

import { NO_ANSWER, ProblemError, type ThreadStatus, type EventRow } from "@clavia/tardigrade-client"

import { clientFor } from "./client"
import { fieldsOf, merged, momentsOf, stampOf, type Field, type Moment } from "./narrative"
import { navigate, useRoute, type Route } from "./nav"
import { BOTTOM_SLACK_PX, EVENT_STAMP_WIDTH, FIELD_COLLAPSED_HEIGHT, FIELD_WIDTH, LOG_POLL_MS, PANE_HEADER_HEIGHT, SUMMARY_WIDTH } from "./policy"
import { axisOf, defaultWindowOf, FULL_WINDOW, shared, shownIn, type Window } from "./window"
import { WindowBrush } from "./WindowBrush"

// The center pane: one thread's log as a flat chronological list under its own header and the window
// brush (mock.html, the main element). The pane holds cursors only: which thread, which range the
// window holds, which row is open. Every fact on it is the server's, read through src/client.ts.

const errorOf = (error: unknown): ProblemError =>
  error instanceof ProblemError ? error : new ProblemError({ title: String(error), status: NO_ANSWER })

const lastSeq = (rows: ReadonlyArray<EventRow>): number => rows[rows.length - 1]?.seq ?? 0

// useLog holds the pane's rows. The first read is the whole log and the stream carries it forward
// from that seq; when the browser gives up reconnecting, the same rows keep filling from `events`,
// which is an ordinary fetch and survives what EventSource cannot (packages/client/src/stream.ts).
const useLog = (actor: string, id: string, pollMs: number) => {
  const [rows, setRows] = useState<ReadonlyArray<EventRow>>([])
  const [problem, setProblem] = useState<ProblemError | undefined>(undefined)
  const [dropped, setDropped] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // The stream's resume point and the poll's cursor are the same number, read outside render so a
  // poll started once does not restart on every append.
  const seen = useRef(0)

  useEffect(() => {
    const client = clientFor(actor)
    let attached = true
    let unsubscribe: (() => void) | undefined
    setRows([])
    setLoaded(false)
    const read = async () => {
      try {
        const first = await client.events(id)
        if (!attached) return
        seen.current = lastSeq(first)
        setRows(first)
        setProblem(undefined)
        setLoaded(true)
        setDropped(false)
        unsubscribe = client.follow(id, {
          after: seen.current,
          onEvent: (row) => {
            seen.current = Math.max(seen.current, row.seq)
            setRows((held) => merged(held, [row]))
          },
          onError: () => setDropped(true)
        })
      } catch (error) {
        if (!attached) return
        setProblem(errorOf(error))
        setLoaded(true)
      }
    }
    void read()
    return () => {
      attached = false
      unsubscribe?.()
    }
  }, [actor, id])

  useEffect(() => {
    if (!dropped) return
    const client = clientFor(actor)
    const timer = setInterval(() => {
      void client.events(id, { after: seen.current })
        .then((batch) => {
          seen.current = Math.max(seen.current, lastSeq(batch))
          setRows((held) => merged(held, batch))
        })
        .catch((error: unknown) => setProblem(errorOf(error)))
    }, pollMs)
    return () => clearInterval(timer)
  }, [actor, id, dropped, pollMs])

  return { rows, problem, dropped, loaded }
}

// windowOf reads the window a URL states. An edge the link omits is that end of the log, so a
// half-written link still opens a window rather than nothing.
const windowOf = (route: Route): Window | undefined =>
  route.from === undefined && route.to === undefined ? undefined : { from: route.from ?? 0, to: route.to ?? 1 }

const FieldValue = ({ collapsedHeight, field }: { readonly collapsedHeight: number; readonly field: Field }): ReactElement => {
  const value = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  useLayoutEffect(() => {
    const element = value.current
    if (element === null) return
    const measure = () => setOverflowing(element.scrollHeight > collapsedHeight + 1)
    measure()
    if (typeof ResizeObserver !== "function") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [collapsedHeight, field.value])

  const classes = `mono event-value${field.kind === "code" ? " event-code" : field.kind === "json" ? " event-json" : ""}`
  return (
    <div className="event-value-frame" style={{ maxWidth: FIELD_WIDTH }}>
      <div
        ref={value}
        className={classes}
        style={expanded ? undefined : { maxHeight: collapsedHeight, overflow: "hidden" }}
      >
        {field.value}
      </div>
      {!overflowing ? null : expanded ? (
        <button type="button" className="field-toggle" onClick={() => setExpanded(false)}>Show less</button>
      ) : (
        <div className="field-more">
          <button type="button" className="field-toggle" onClick={() => setExpanded(true)}>Show more</button>
        </div>
      )}
    </div>
  )
}

// An opened row's fields, hanging off the row on one hairline: the event's own names on the left,
// its values on the page's own ground on the right. There is no card, because the expansion is the
// row saying more rather than a second surface (mock.html, .ev-detail). The keys and values are
// src/narrative.ts's answer, so what a type shows is a tested fact rather than a render decision.
const Detail = ({
  collapsedHeight,
  moment,
  stampWidth
}: {
  readonly collapsedHeight: number
  readonly moment: Moment
  readonly stampWidth: number
}): ReactElement => (
  <div
    className="event-detail fade-in"
    style={{ marginLeft: `calc(${stampWidth}px + var(--space-2) + var(--space-3))` }}
  >
    {fieldsOf(moment.event).map((field) => (
      <Fragment key={field.key}>
        <span className="mono event-key">{field.key}</span>
        <FieldValue field={field} collapsedHeight={collapsedHeight} />
      </Fragment>
    ))}
  </div>
)

const Row = ({
  moment,
  onToggle,
  open,
  fieldCollapsedHeight,
  stampWidth
}: {
  readonly moment: Moment
  readonly onToggle: () => void
  readonly open: boolean
  readonly fieldCollapsedHeight: number
  readonly stampWidth: number
}): ReactElement => {
  const stamp = stampOf(moment.event.type)
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className={`event-row${open ? " event-row-open" : ""}`}
        onClick={onToggle}
        onKeyDown={(pressed) => {
          if (pressed.key !== "Enter" && pressed.key !== " ") return
          pressed.preventDefault()
          onToggle()
        }}
      >
        <span className="mono event-stamp" style={{ background: stamp.bg, color: stamp.fg, width: stampWidth }}>
          {moment.event.type}
        </span>
        {/* A collapsed line takes the pane's whole width; only the wrapped line an open row shows
            keeps a measure (src/policy.ts, SUMMARY_WIDTH). */}
        <span className="event-text" style={open ? { maxWidth: SUMMARY_WIDTH } : undefined}>
          {moment.summary}
        </span>
        <span className="mono event-time">
          {moment.time}
          {moment.duration === undefined ? "" : ` · ${moment.duration}`}
        </span>
      </div>
      {!open ? null : <Detail moment={moment} collapsedHeight={fieldCollapsedHeight} stampWidth={stampWidth} />}
    </div>
  )
}

const Problem = ({ problem }: { readonly problem: ProblemError }): ReactElement => (
  <div className="problem" style={{ margin: "0 var(--space-5) var(--space-3)" }}>
    <div className="problem-title">{problem.title}</div>
    {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
  </div>
)

const Head = ({ id, status }: { readonly id: string; readonly status: ThreadStatus | undefined }): ReactElement => (
  <div className="thread-head">
    <span className="mono" style={{ fontSize: "var(--text-dense)", fontWeight: 500 }}>{id}</span>
    {status === undefined ? null : (
      <span className={`chip chip-${status}${status === "running" ? " breathe" : ""}`}>{status}</span>
    )}
  </div>
)

export const Thread = ({
  actor,
  fieldCollapsedHeight = FIELD_COLLAPSED_HEIGHT,
  headerHeight = PANE_HEADER_HEIGHT,
  id,
  stampWidth = EVENT_STAMP_WIDTH,
  status
}: {
  readonly actor: string
  readonly id: string
  readonly fieldCollapsedHeight?: number | undefined
  readonly headerHeight?: number | undefined
  readonly stampWidth?: number | undefined
  readonly status: ThreadStatus | undefined
}): ReactElement => {
  const route = useRoute()
  // The window's own edges. The URL carries them so a view is shareable, and the pane holds them so
  // a drag renders from one place: `navigate` publishes the URL synchronously, and a control that
  // read its value back out of that publication would render one step behind the handle (src/nav.ts).
  const [window, setWindow] = useState<Window | undefined>(windowOf(route))
  const [opened, setOpened] = useState<number | undefined>(undefined)
  const { dropped, loaded, problem, rows } = useLog(actor, id, LOG_POLL_MS)

  const pane = useRef<HTMLDivElement | null>(null)
  // Whether the reader is at the log's end. Auto-scroll follows a live log only from there; a reader
  // who has scrolled up is reading, and the log must not pull the page away from them.
  const atEnd = useRef(true)
  // Whether this thread's log has been given its opening window. The default is read once, from the
  // first full reading; recomputing it as events arrive would move the window under the reader.
  const seeded = useRef(false)

  useEffect(() => {
    setOpened(undefined)
    atEnd.current = true
    seeded.current = false
  }, [actor, id])

  // A route the pane did not write is one it must follow: a shared link, or a back button
  // (src/nav.ts, useRoute). A drag of its own lands here already equal and changes nothing.
  useEffect(() => {
    setWindow(windowOf(route))
  }, [route.from, route.to])

  useEffect(() => {
    const element = pane.current
    if (element === null || !atEnd.current) return
    element.scrollTop = element.scrollHeight
  }, [rows])

  const moments = momentsOf(rows)
  const axis = axisOf(moments)

  // The opening window, written into the URL so the view a reader arrives at is the view they can
  // share. A link that already states a window keeps it.
  useEffect(() => {
    if (seeded.current || !loaded || rows.length === 0) return
    seeded.current = true
    if (window !== undefined) return
    const next = shared(defaultWindowOf(momentsOf(rows)))
    setWindow(next)
    navigate({ from: next.from, to: next.to }, { replace: true })
  }, [loaded, rows, window])

  const held = window ?? FULL_WINDOW
  const shown = shownIn(moments, axis, held)

  // A drag replaces rather than pushes, so forty steps do not cost forty back presses.
  const onWindow = (next: Window) => {
    setWindow(next)
    const link = shared(next)
    navigate({ from: link.from, to: link.to }, { replace: true })
  }

  // A thread the server has never heard of has no log to read, so the pane is its header and the
  // problem document verbatim (apps/server/src/problem.ts).
  if (problem !== undefined && problem.status === 404) {
    return (
      <>
        <div className="pane-chrome" style={{ height: headerHeight }}>
          <Head id={id} status={status} />
        </div>
        <Problem problem={problem} />
      </>
    )
  }

  return (
    <>
      <div className="pane-chrome" style={{ height: headerHeight }}>
        <Head id={id} status={status} />
      </div>
      <WindowBrush axis={axis} moments={moments} shown={shown} window={held} onChange={onWindow} />
      {problem === undefined ? null : <Problem problem={problem} />}
      {!dropped ? null : <div className="mono stream-note">stream dropped; polling</div>}
      <div
        ref={pane}
        className="events"
        onScroll={() => {
          const element = pane.current
          if (element === null) return
          atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK_PX
        }}
      >
        {shown.length === 0
          ? loaded && problem === undefined
            ? <div className="mono pane-empty">{moments.length === 0 ? "no events yet" : "no events in the window"}</div>
            : null
          : shown.map((moment) => (
              <Row
                key={moment.seq}
                moment={moment}
                open={opened === moment.seq}
                fieldCollapsedHeight={fieldCollapsedHeight}
                stampWidth={stampWidth}
                onToggle={() => setOpened(opened === moment.seq ? undefined : moment.seq)}
              />
            ))}
      </div>
    </>
  )
}
