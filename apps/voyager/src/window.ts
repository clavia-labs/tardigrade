import { clockOf, type Moment } from "./narrative"
import {
  COPY_TYPE_WIDTH,
  DEFAULT_WINDOW_EVENTS,
  WINDOW_BUCKETS,
  WINDOW_MIN_GAP,
  WINDOW_URL_DECIMALS
} from "./policy"

// The window's arithmetic: where the log's events sit on one time axis, how dense each slice of it
// is, which events a window holds, and what the copied window reads as. Every function here is
// pure, so the brush is these answers rendered and the tests are arrays of moments.

// Window is the brush's two edges, as fractions of the log's time span: 0 is the first event's
// instant and 1 is the last. The URL carries the same two numbers (src/nav.ts, Route).
export interface Window {
  readonly from: number
  readonly to: number
}

export const FULL_WINDOW: Window = { from: 0, to: 1 }

// Axis is the span the fractions are measured against. `span` is never zero, so a log of one event
// still divides: every instant in it maps to fraction 0.
export interface Axis {
  readonly lo: number
  readonly hi: number
  readonly span: number
}

const stamps = (moments: ReadonlyArray<Moment>): ReadonlyArray<number> =>
  moments.map((moment) => moment.at).filter((at): at is number => at !== undefined)

// axisOf reads the axis off the log itself. An empty log, or one the host stamped no clock on, has
// a zero-length axis at the epoch, which renders as an empty strip rather than as NaN.
export const axisOf = (moments: ReadonlyArray<Moment>): Axis => {
  const times = stamps(moments)
  const lo = times.length === 0 ? 0 : Math.min(...times)
  const hi = times.length === 0 ? 0 : Math.max(...times)
  return { lo, hi, span: hi - lo === 0 ? 1 : hi - lo }
}

// fractionOf places one instant on the axis, clamped to the track's ends.
const fractionOf = (axis: Axis, at: number): number =>
  Math.min(1, Math.max(0, (at - axis.lo) / axis.span))

// instantAt is the inverse: the clock a handle sits over.
export const instantAt = (axis: Axis, fraction: number): number => axis.lo + axis.span * fraction

// bucketsOf counts the events in each slice of the axis. The strip draws these counts, so a bar's
// height is the log's own density in that slice and a burst of polling is visible as one.
export const bucketsOf = (
  moments: ReadonlyArray<Moment>,
  axis: Axis,
  count: number = WINDOW_BUCKETS
): ReadonlyArray<number> => {
  const counts = Array.from({ length: count }, () => 0)
  for (const at of stamps(moments)) {
    const index = Math.min(count - 1, Math.max(0, Math.floor(fractionOf(axis, at) * count)))
    counts[index] = (counts[index] ?? 0) + 1
  }
  return counts
}

// holds is the window's membership test. An event the host stamped no clock on sits at no fraction,
// so no window can hide it: the alternative is an event that is invisible at every handle position.
const holds = (window: Window, axis: Axis, moment: Moment): boolean => {
  if (moment.at === undefined) return true
  const fraction = fractionOf(axis, moment.at)
  return fraction >= window.from && fraction <= window.to
}

export const shownIn = (moments: ReadonlyArray<Moment>, axis: Axis, window: Window): ReadonlyArray<Moment> =>
  moments.filter((moment) => holds(window, axis, moment))

// defaultWindowOf is where the brush opens: the last `events` events of a longer log, and the whole
// of a shorter one. A reader arrives at the end, which is where a live run is writing.
export const defaultWindowOf = (
  moments: ReadonlyArray<Moment>,
  events: number = DEFAULT_WINDOW_EVENTS
): Window => {
  const times = stamps(moments)
  if (times.length <= events) return FULL_WINDOW
  const axis = axisOf(moments)
  const first = times[times.length - events]
  return first === undefined ? FULL_WINDOW : { from: fractionOf(axis, first), to: 1 }
}

// moved answers where a dragged handle lands. The handles cannot cross and cannot close nearer than
// `gap`, so the pushed-away edge holds its ground rather than the two swapping roles mid-drag.
export const moved = (
  window: Window,
  edge: "from" | "to",
  fraction: number,
  gap: number = WINDOW_MIN_GAP
): Window => {
  const held = Math.min(1, Math.max(0, fraction))
  return edge === "from"
    ? { from: Math.min(held, window.to - gap), to: window.to }
    : { from: window.from, to: Math.max(held, window.from + gap) }
}

// shared is the window as the URL states it: the same two edges at the resolution a link needs
// (src/nav.ts, Route).
export const shared = (window: Window, decimals: number = WINDOW_URL_DECIMALS): Window => ({
  from: Number(window.from.toFixed(decimals)),
  to: Number(window.to.toFixed(decimals))
})

// readoutOf is the mono line beside the eyebrow: the window's two clocks and how much of the log it
// holds.
export const readoutOf = (
  axis: Axis,
  window: Window,
  shown: number,
  total: number
): { readonly range: string; readonly count: string } => ({
  range: `${clockOf(instantAt(axis, window.from))} → ${clockOf(instantAt(axis, window.to))}`,
  count: `${shown}/${total}`
})

// copyTextOf renders the window's events as plain text, one line per event: the clock, the event's
// own type, and the line the row shows. The type is padded so the three columns align wherever the
// text is pasted (src/policy.ts, COPY_TYPE_WIDTH).
export const copyTextOf = (moments: ReadonlyArray<Moment>, typeWidth: number = COPY_TYPE_WIDTH): string =>
  moments
    .map((moment) => `${moment.time}  ${moment.event.type.padEnd(typeWidth)}  ${moment.summary}`)
    .join("\n")
