import { Check, Copy } from "@phosphor-icons/react"
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react"

import { clockOf, type Moment } from "./narrative"
import {
  COPY_CONFIRM_MS,
  ICON_SIZE,
  WINDOW_BAR_BASE,
  WINDOW_BAR_MIN,
  WINDOW_KEY_STEP,
  WINDOW_MARKS,
  WINDOW_TRACK_HEIGHT
} from "./policy"
import { bucketsOf, copyTextOf, instantAt, moved, readoutOf, type Axis, type Window } from "./window"

// The window brush: the log's density in one strip, and two handles that cut the list to a range.
// It filters rather than dims, so what the reader sees below is exactly what the handles hold, and
// what the copy control writes out (mock.html, #window).

// copyText puts one string on the clipboard and answers whether it landed. The clipboard API
// rejects when the page is not a secure context or the document lost focus, so the textarea path is
// what makes the confirmation honest rather than optimistic.
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement("textarea")
    area.value = text
    area.style.position = "fixed"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    return ok
  }
}

// The copy control. The glyph swaps through React state rather than through a style, because an
// inline `display` outranks the class rules that would otherwise do the swap.
const CopyButton = ({ text, confirmMs }: { readonly text: string; readonly confirmMs: number }): ReactElement => {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), confirmMs)
    return () => clearTimeout(timer)
  }, [copied, confirmMs])

  return (
    <button
      type="button"
      className={`icon-btn${copied ? " icon-btn-done" : ""}`}
      aria-label="Copy the window's events"
      title="Copy the window's events"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) setCopied(true)
        })
      }}
    >
      {copied ? (
        <Check size={ICON_SIZE} weight="light" aria-hidden="true" />
      ) : (
        <Copy size={ICON_SIZE} weight="light" aria-hidden="true" />
      )}
    </button>
  )
}

const Handle = ({
  edge,
  fraction,
  onDrag,
  onStep
}: {
  readonly edge: "from" | "to"
  readonly fraction: number
  readonly onDrag: (event: ReactPointerEvent<HTMLDivElement>) => void
  readonly onStep: (delta: number) => void
}): ReactElement => (
  <div
    role="slider"
    tabIndex={0}
    aria-label={edge === "from" ? "Window start" : "Window end"}
    aria-valuemin={0}
    aria-valuemax={1}
    aria-valuenow={fraction}
    className="window-handle"
    style={{ left: `${fraction * 100}%` }}
    onPointerDown={onDrag}
    onKeyDown={(pressed) => {
      const delta = pressed.key === "ArrowLeft" ? -WINDOW_KEY_STEP : pressed.key === "ArrowRight" ? WINDOW_KEY_STEP : 0
      if (delta === 0) return
      pressed.preventDefault()
      onStep(delta)
    }}
  >
    <div className="window-grip" />
  </div>
)

export const WindowBrush = ({
  axis,
  moments,
  onChange,
  shown,
  window
}: {
  readonly axis: Axis
  readonly moments: ReadonlyArray<Moment>
  readonly onChange: (next: Window) => void
  readonly shown: ReadonlyArray<Moment>
  readonly window: Window
}): ReactElement => {
  const track = useRef<HTMLDivElement | null>(null)
  const buckets = bucketsOf(moments, axis)
  const peak = Math.max(1, ...buckets)
  const readout = readoutOf(axis, window, shown.length, moments.length)

  // A drag reads the pointer against the track's own box, so the handle lands where the cursor is
  // rather than where the last render put it.
  const grab = (edge: "from" | "to") => (pressed: ReactPointerEvent<HTMLDivElement>) => {
    pressed.preventDefault()
    const box = track.current?.getBoundingClientRect()
    if (box === undefined || box.width === 0) return
    let held = window
    const move = (moving: PointerEvent) => {
      held = moved(held, edge, (moving.clientX - box.left) / box.width)
      onChange(held)
    }
    const up = () => {
      removeEventListener("pointermove", move)
      removeEventListener("pointerup", up)
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
  }

  return (
    <div className="window">
      <div className="window-head">
        <span className="window-eyebrow">window</span>
        <span className="window-actions">
          <span className="mono window-readout">
            {readout.range} <span className="window-count">· {readout.count}</span>
          </span>
          <CopyButton text={copyTextOf(shown)} confirmMs={COPY_CONFIRM_MS} />
        </span>
      </div>
      <div ref={track} className="window-track" style={{ height: WINDOW_TRACK_HEIGHT }}>
        <div className="window-bars">
          {buckets.map((count, index) => {
            const middle = (index + 0.5) / buckets.length
            const inside = middle >= window.from && middle <= window.to
            const height = count === 0 ? WINDOW_BAR_MIN : WINDOW_BAR_BASE + (count / peak) * (100 - WINDOW_BAR_BASE)
            return (
              <div
                // The buckets are a fixed-length strip in axis order, so the index is the identity.
                key={index}
                className={`window-bar${inside ? " window-bar-inside" : ""}`}
                style={{ height: `${height}%` }}
              />
            )
          })}
        </div>
        <div
          className="window-selection"
          style={{ left: `${window.from * 100}%`, right: `${(1 - window.to) * 100}%` }}
        />
        <Handle
          edge="from"
          fraction={window.from}
          onDrag={grab("from")}
          onStep={(delta) => onChange(moved(window, "from", window.from + delta))}
        />
        <Handle
          edge="to"
          fraction={window.to}
          onDrag={grab("to")}
          onStep={(delta) => onChange(moved(window, "to", window.to + delta))}
        />
      </div>
      <div className="mono window-marks">
        {Array.from({ length: WINDOW_MARKS }, (_, index) => index / (WINDOW_MARKS - 1)).map((fraction) => (
          <span key={fraction}>{clockOf(instantAt(axis, fraction))}</span>
        ))}
      </div>
    </div>
  )
}
