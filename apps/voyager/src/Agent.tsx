import { Fragment, useEffect, useRef, useState, type ReactElement } from "react"

import { events, stream, VoyagerError, type AgentStatus, type EventRow } from "./api"
import { fieldsOf, merged, momentsOf, stampOf, type Moment } from "./narrative"
import { navigate, useRoute } from "./nav"
import { BOTTOM_SLACK_PX, FIELD_WIDTH, LOG_POLL_MS, SCRUB_DIM, SUMMARY_WIDTH } from "./policy"
import { useTheme } from "./theme"

// The center pane: one agent's log as a flat chronological list under its own header and the seq
// scrubber (mock.html, the main element). The pane holds cursors only: which agent, where the scrub
// sits, which row is open. Every fact on it is the server's, read through src/api.ts.

const errorOf = (error: unknown): VoyagerError =>
  error instanceof VoyagerError ? error : new VoyagerError({ title: String(error), status: 0 })

const lastSeq = (rows: ReadonlyArray<EventRow>): number => rows[rows.length - 1]?.seq ?? 0

// useLog holds the pane's rows. The first read is the whole log and the stream carries it forward
// from that seq; when the browser gives up reconnecting, the same rows keep filling from `events`,
// which is an ordinary fetch and survives what EventSource cannot (src/api.ts, stream).
const useLog = (id: string, pollMs: number) => {
  const [rows, setRows] = useState<ReadonlyArray<EventRow>>([])
  const [problem, setProblem] = useState<VoyagerError | undefined>(undefined)
  const [dropped, setDropped] = useState(false)
  const [loaded, setLoaded] = useState(false)
  // The stream's resume point and the poll's cursor are the same number, read outside render so a
  // poll started once does not restart on every append.
  const seen = useRef(0)

  useEffect(() => {
    let attached = true
    let unsubscribe: (() => void) | undefined
    setRows([])
    setLoaded(false)
    const read = async () => {
      try {
        const first = await events(id)
        if (!attached) return
        seen.current = lastSeq(first)
        setRows(first)
        setProblem(undefined)
        setLoaded(true)
        setDropped(false)
        unsubscribe = stream(id, {
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
  }, [id])

  useEffect(() => {
    if (!dropped) return
    const timer = setInterval(() => {
      void events(id, { after: seen.current })
        .then((batch) => {
          seen.current = Math.max(seen.current, lastSeq(batch))
          setRows((held) => merged(held, batch))
        })
        .catch((error: unknown) => setProblem(errorOf(error)))
    }, pollMs)
    return () => clearInterval(timer)
  }, [id, dropped, pollMs])

  return { rows, problem, dropped, loaded }
}

// The theme toggle is the one icon in the app. Type, dots, and hairlines do everything else, and an
// icon earns its way in only by a recorded decision; this is that decision, because the sun and the
// moon name the two themes in one glyph and no word does (voyager-design-system.md, "No icons").
const ThemeToggle = (): ReactElement => {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      className="icon-button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
      title="Toggle theme"
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  )
}

// The scrub is the log's seq axis: the track is a well, the handle is the moss dot, and the readout
// follows it. Dragging navigates with `replace`, so a drag leaves one history entry rather than
// forty (src/nav.ts, navigate).
const Scrub = ({
  max,
  onScrub,
  position
}: {
  readonly max: number
  readonly onScrub: (seq: number) => void
  readonly position: number
}): ReactElement => {
  const fraction = max === 0 ? 1 : position / max
  return (
    <div className="scrub-well">
      <div className="scrub-track">
        <div className="scrub-fill" style={{ width: `${fraction * 100}%` }} />
        <input
          className="scrub-input"
          type="range"
          min={0}
          max={max}
          step={1}
          value={position}
          aria-label="scrub the log by seq"
          disabled={max === 0}
          onChange={(changed) => onScrub(Number(changed.target.value))}
        />
      </div>
      <span className="mono scrub-readout">
        seq {position} / {max}
      </span>
    </div>
  )
}

// An opened row's fields, hanging off the row on one hairline: the event's own names on the left,
// its values on the page's own ground on the right. There is no card, because the expansion is the
// row saying more rather than a second surface (mock.html, .ev-detail). The keys and values are
// src/narrative.ts's answer, so what a type shows is a tested fact rather than a render decision.
const Detail = ({ moment }: { readonly moment: Moment }): ReactElement => (
  <div className="event-detail fade-in">
    {fieldsOf(moment.event).map((field) => (
      <Fragment key={field.key}>
        <span className="mono event-key">{field.key}</span>
        <span
          className={`mono event-value${field.kind === "code" ? " event-code" : ""}`}
          style={{ maxWidth: FIELD_WIDTH }}
        >
          {field.value}
        </span>
      </Fragment>
    ))}
  </div>
)

const Row = ({
  dimmed,
  moment,
  onToggle,
  open
}: {
  readonly dimmed: boolean
  readonly moment: Moment
  readonly onToggle: () => void
  readonly open: boolean
}): ReactElement => {
  const stamp = stampOf(moment.event.type)
  return (
    <div style={{ opacity: dimmed ? SCRUB_DIM : 1 }}>
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
        <span className="mono event-stamp" style={{ background: stamp.bg, color: stamp.fg }}>
          {moment.event.type}
        </span>
        <span className="event-text" style={{ maxWidth: SUMMARY_WIDTH }}>{moment.summary}</span>
        <span className="mono event-time">
          {moment.time}
          {moment.duration === undefined ? "" : ` · ${moment.duration}`}
        </span>
      </div>
      {!open ? null : <Detail moment={moment} />}
    </div>
  )
}

const Problem = ({ problem }: { readonly problem: VoyagerError }): ReactElement => (
  <div className="problem" style={{ margin: "0 var(--space-5) var(--space-3)" }}>
    <div className="problem-title">{problem.title}</div>
    {problem.detail === undefined ? null : <div className="problem-detail">{problem.detail}</div>}
  </div>
)

const Head = ({ id, status }: { readonly id: string; readonly status: AgentStatus | undefined }): ReactElement => (
  <div className="agent-head">
    <span className="mono" style={{ fontSize: "var(--text-dense)", fontWeight: 500 }}>{id}</span>
    {status === undefined ? null : (
      <span className={`chip chip-${status}${status === "running" ? " breathe" : ""}`}>{status}</span>
    )}
    <span style={{ marginLeft: "auto" }} />
    <ThemeToggle />
  </div>
)

export const Agent = ({ id, status }: { readonly id: string; readonly status: AgentStatus | undefined }): ReactElement => {
  const route = useRoute()
  // The scrub's own cursor. The URL carries it so a view is shareable, and the pane holds it so a
  // drag renders from one place: `navigate` publishes the URL synchronously, and a control that read
  // its value back out of that publication would render one step behind the handle (src/nav.ts).
  const [at, setAt] = useState<number | undefined>(route.at)
  const [opened, setOpened] = useState<number | undefined>(undefined)
  const { dropped, loaded, problem, rows } = useLog(id, LOG_POLL_MS)

  const pane = useRef<HTMLDivElement | null>(null)
  // Whether the reader is at the log's end. Auto-scroll follows a live log only from there; a reader
  // who has scrolled up is reading, and the log must not pull the page away from them.
  const atEnd = useRef(true)

  useEffect(() => {
    setOpened(undefined)
    atEnd.current = true
  }, [id])

  // A route the pane did not write is one it must follow: a shared link, or a back button
  // (src/nav.ts, useRoute). A scrub of its own lands here already equal and changes nothing.
  useEffect(() => {
    setAt(route.at)
  }, [route.at])

  useEffect(() => {
    const element = pane.current
    if (element === null || !atEnd.current) return
    element.scrollTop = element.scrollHeight
  }, [rows])

  const max = lastSeq(rows)
  const position = at === undefined ? max : Math.min(at, max)
  const moments = momentsOf(rows)

  // Scrubbing states a past moment, and the log keeps arriving behind it: the rows past the position
  // dim rather than disappear. A drag replaces rather than pushes, so forty steps do not cost forty
  // back presses.
  const onScrub = (seq: number) => {
    setAt(seq === max ? undefined : seq)
    navigate({ at: seq === max ? undefined : seq }, { replace: true })
  }

  // An agent the server has never heard of has no log to scrub, so the pane is its header and the
  // problem document verbatim (apps/server/src/problem.ts).
  if (problem !== undefined && problem.status === 404) {
    return (
      <>
        <Head id={id} status={status} />
        <Problem problem={problem} />
      </>
    )
  }

  return (
    <>
      <Head id={id} status={status} />
      <Scrub max={max} position={position} onScrub={onScrub} />
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
        {moments.length === 0
          ? loaded && problem === undefined
            ? <div className="mono pane-empty">no events yet</div>
            : null
          : moments.map((moment) => (
              <Row
                key={moment.seq}
                moment={moment}
                dimmed={moment.seq > position}
                open={opened === moment.seq}
                onToggle={() => setOpened(opened === moment.seq ? undefined : moment.seq)}
              />
            ))}
      </div>
    </>
  )
}
