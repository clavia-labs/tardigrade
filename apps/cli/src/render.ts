import type {
  EventRow,
  MethodState,
  MethodSummary,
  ModelCatalogPage,
  ProviderCatalogPage,
  ThreadSummary
} from "@clavia/tardigrade-client"

// What a command puts on stdout. Two renderings of the same value: aligned text for a person and
// the client's own value for a pipe (`--json`), which is why every function here takes what the
// client answered and nothing else. No colour and no icons: a table that is only readable on a
// terminal that understands escapes is not readable in a log, a pager, or a pull request
// (render.test.ts).

// How wide an event's detail column is allowed to run before it is cut. A log line is meant to be
// scanned, and one event carrying a whole tool payload would push every other column off screen.
// `tdg events --width` sets it, and `--json` is the rendering with no cut at all.
export const DEFAULT_DETAIL_WIDTH = 96

// What stands in a cell whose value the projection did not carry.
export const ABSENT = "-"

export const jsonOf = (value: unknown): string => JSON.stringify(value, undefined, 2)

// table lays out rows under headers, padding each column to its widest cell. Two spaces separate
// columns, so a value containing one space still reads as one cell.
export const table = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = headers.map((header, column) =>
    rows.reduce((width, row) => Math.max(width, (row[column] ?? "").length), header.length)
  )
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd()
  return [line(headers), ...rows.map(line)].join("\n")
}

// The mark a cut leaves, so a reader can tell a cut value from a short one.
export const ELLIPSIS = "..."

const truncate = (value: string, width: number): string =>
  value.length <= width ? value : `${value.slice(0, Math.max(width - ELLIPSIS.length, 0))}${ELLIPSIS}`

const timeOf = (at: number | undefined): string =>
  at === undefined ? ABSENT : new Date(at).toISOString()

// Every thread a store holds, parent before child. `events` is the count of events in the log, which is the size of the
// thing every other read projects from, and `last` is when the log last grew.
export const threadsTable = (threads: ReadonlyArray<ThreadSummary>): string =>
  threads.length === 0
    ? "no threads"
    : table(
      ["THREAD", "STATUS", "DEPTH", "EVENTS", "LAST", "PARENT"],
      threads.map((thread) => [
        thread.id,
        thread.status,
        String(thread.depth),
        String(thread.events),
        timeOf(thread.lastAt),
        thread.parent ?? ABSENT
      ])
    )

const catalogFooter = (page: {
  readonly revision: string
  readonly status: "fresh" | "cached"
  readonly total: number
  readonly limit: number
  readonly next_cursor?: string
}): string => [
  `${page.total} total, limit ${page.limit}, ${page.status}, revision ${page.revision}`,
  ...(page.next_cursor === undefined ? [] : [`next cursor ${page.next_cursor}`])
].join("\n")

export const providersTable = (page: ProviderCatalogPage): string => {
  const body = page.items.length === 0
    ? "no providers"
    : table(
      ["PROVIDER", "STATUS", "PROTOCOL", "ENDPOINT", "REQUIRED", "ENV"],
      page.items.map((provider) => [
        provider.id,
        provider.availability.status === "available" ? "available" : provider.availability.reason,
        provider.protocol ?? ABSENT,
        provider.baseUrl ?? ABSENT,
        provider.required.join(",") || ABSENT,
        provider.env.join(",") || ABSENT
      ])
    )
  return `${body}\n\n${catalogFooter(page)}`
}

export const modelsTable = (page: ModelCatalogPage): string => {
  const body = page.items.length === 0
    ? "no models"
    : table(
      ["PROVIDER", "MODEL", "NAME", "CONTEXT", "OUTPUT", "TOOLS"],
      page.items.map((model) => [
        model.provider,
        model.id,
        model.name ?? ABSENT,
        model.metadata.contextWindowTokens === undefined ? ABSENT : String(model.metadata.contextWindowTokens),
        model.metadata.maxOutputTokens === undefined ? ABSENT : String(model.metadata.maxOutputTokens),
        model.metadata.toolCall === undefined ? ABSENT : String(model.metadata.toolCall)
      ])
    )
  return `${body}\n\n${catalogFooter(page)}`
}

// The fields of an event other than its type, as one compact object. The type is already a column,
// and what remains is what tells two events of one type apart.
const detailOf = (row: EventRow): string => {
  const { type: _type, ...rest } = row.event
  const keys = Object.keys(rest)
  return keys.length === 0 ? "" : JSON.stringify(rest)
}

// One line per event, which is what makes the log greppable. `seq` is the event's position in the
// whole log and survives a `--types` filter, so a filtered listing still names real positions
// (apps/server/src/api.ts, "events").
export const eventsTable = (rows: ReadonlyArray<EventRow>, width = DEFAULT_DETAIL_WIDTH): string =>
  rows.length === 0
    ? "no events"
    : table(
      ["SEQ", "TYPE", "DETAIL"],
      rows.map((row) => [String(row.seq), row.event.type, truncate(detailOf(row), width)])
    )

// methodLines renders a call handle, its durable status, and any terminal detail.
export const methodLines = (thread: string, call: string, state: MethodState): string => {
  const head = `${thread} ${call} ${state.status}`
  if (state.status === "completed") {
    const output = typeof state.output === "string" ? state.output : jsonOf(state.output)
    return `${head}\n${output}`
  }
  if (state.status === "failed") return `${head}\n${state.error}`
  return head
}

// methodsLines renders each method with the input and output schemas an author calls against.
export const methodsLines = (methods: ReadonlyArray<MethodSummary>): string =>
  methods.length === 0
    ? "no methods"
    : methods.map((method) => [
      method.name,
      `  input  ${JSON.stringify(method.inputSchema)}`,
      `  output ${JSON.stringify(method.outputSchema)}`
    ].join("\n")).join("\n\n")
