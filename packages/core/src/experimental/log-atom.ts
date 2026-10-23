import { Context } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import type { Atom, Getter } from "../atoms/atom"
import { EventLog, eventLogContext } from "../services/event-log"
import { RuntimeError } from "../runtime/effects"
import { readLogViewPage, logViewSchema, type LogView, type LogSource, type LogReadOptions, type LogReadPage } from "./log"

export const DEFAULT_LOG_ATOM_IDLE_TTL = 0

// logSource exposes the consumed replay prefix through the standalone log reader (platform/test/properties/log.ts, logViews).
export function logSource(get: Getter): LogSource {
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const replay = get(Context.get(context, EventLog).replay)
  return {
    readPosition: () => replay.position,
    readRange: (from, to) => replay.read(from).slice(0, to - from),
    ...(replay.readFamily ? { readFamily: (family, key, from, to, order) => replay.readFamily!(family, key, from, { to, ...(order ? { order } : {}) }) } : {}),
  }
}

export interface AtomLogRangeOptions extends LogReadOptions {
  readonly from?: number
  readonly to?: number
}

export interface AtomLogView<Row> {
  readonly range: (options?: AtomLogRangeOptions) => Atom<LogReadPage<Row>>
}

// atomLogView adapts event-key views into reactive pages with configurable idle retention (platform/test/properties/log.ts, logViews).
export function atomLogView<Row>(view: LogView<Row>, options: { readonly idleTTL?: number } = {}): AtomLogView<Row> {
  const idleTTL = options.idleTTL ?? DEFAULT_LOG_ATOM_IDLE_TTL
  if (!(idleTTL >= 0) || (idleTTL !== Infinity && !Number.isFinite(idleTTL))) throw new RuntimeError("Log atom idleTTL must be nonnegative milliseconds or Infinity")
  const input = logViewSchema(view)
  const pages = NativeAtom.family((identity: string) => {
    const query = JSON.parse(identity) as AtomLogRangeOptions
    return Object.assign(NativeAtom.readable(get => {
      const source = logSource(get)
      const selection = view.range({ from: query.after?.from ?? query.from ?? 0, to: query.after?.to ?? query.to ?? source.readPosition() })
      if ((query.from !== undefined && query.from !== selection.from) || (query.to !== undefined && query.to !== selection.to)) throw new RuntimeError("Log cursor does not belong to this range")
      return readLogViewPage(view, source, selection, query)
    }).pipe(NativeAtom.setIdleTTL(idleTTL)), { input })
  })
  return { range: (query = {}) => pages(JSON.stringify(query)) }
}
