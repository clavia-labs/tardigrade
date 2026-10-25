import { ModelCalled, Trajectory, type Conversation, type ToolReturned } from "../../contracts/events"
import { Schema } from "effect"
import { RuntimeError, type Atom, type Getter } from "@clavia/tardigrade-core"
import { durableAtom } from "@clavia/tardigrade-core/experimental"
import { logSource } from "@clavia/tardigrade-core/experimental/log-atom"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { type LogReadPage, type LogReadOptions } from "@clavia/tardigrade-core/experimental"
import { legacyTrajectorySeed, legacyToolAttribution, legacyTrajectoryCursor } from "../../compat/trajectory"
import { agentLog, trajectoryLog, trajectoryRevision } from "../../experimental/trajectory-log"

export interface TrajectoryRangeOptions extends LogReadOptions {
  readonly from?: number
  readonly to?: number
}

export interface TrajectorySource<Row> {
  readonly selection?: typeof trajectoryLog.range
  // revision identifies an append-only source whose projected rows remain immutable (platform/test/properties/turn-facts.ts, trajectoryWindowCache).
  readonly revision?: (get: Getter) => { readonly source: object; readonly position: number }
  readonly legacyCursor?: (get: Getter, through: number) => number
  readonly range: (options?: TrajectoryRangeOptions) => Atom<LogReadPage<Row>>
}

const modelTurns = durableAtom.family({
  name: "agent.trajectory.model-turn", input: ModelCalled, schema: Schema.UndefinedOr(Schema.String), initial: undefined,
  key: event => event.purpose === "inference" ? event.callId : undefined,
  reduce: (state, event) => event.purpose === "inference" ? event.turnId : state,
})
// toolAttribution reads recorded metadata directly and uses a bounded legacy fold for older results.
function toolAttribution(get: Getter, event: ToolReturned, position: number) {
  return event.tool && event.turnId !== undefined ? { turnId: event.turnId, ...event.tool } : legacyToolAttribution(get, event.callId, position)
}

const eventPages = durableAtom.log(trajectoryLog)
const pages = NativeAtom.family((identity: string): Atom<LogReadPage<typeof Trajectory.Type[number]>> => Object.assign(NativeAtom.readable(get => {
  if (get(legacyTrajectorySeed)) throw new RuntimeError("Trajectory logs require journal history; aggregate trajectory initial state is unsupported")
  const query = JSON.parse(identity) as TrajectoryRangeOptions
  const source = logSource(get)
  const selection = trajectoryLog.range({ from: query.after?.from ?? query.from ?? 0, to: query.after?.to ?? query.to ?? source.readPosition() })
  const limit = query.limit ?? agentLog.pageSize
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER) throw new RuntimeError("Invalid trajectory page limit")
  const order = query.order ?? query.after?.order ?? "asc"
  const rows: Array<{ position: number; value: typeof Trajectory.Type[number] }> = []
  let after = query.after
  while (true) {
    const page = get(eventPages.range({ from: selection.from, to: selection.to, limit: Math.min(limit - rows.length + 1, Number.MAX_SAFE_INTEGER - 1), order, ...(after ? { after } : {}) }))
    for (const { position, value: event } of page.rows) {
      if (event.type === "TurnRequested") rows.push({ position, value: { turnId: event.turnId, message: event.content === undefined ? { role: "user", text: event.text } : { role: "user", content: event.content } } })
      if (event.type === "ModelReturned" && event.purpose === "inference") {
        const turnId = event.turnId ?? get(modelTurns(event.callId))
        if (turnId !== undefined) rows.push({ position, value: { turnId, message: { role: "assistant", text: event.text, toolCalls: event.toolCalls, ...(event.outputLimit === undefined ? {} : { outputLimit: event.outputLimit }), ...(event.reasoning === undefined ? {} : { reasoning: event.reasoning }), ...(event.continuation === undefined ? {} : { continuation: event.continuation }) } } })
      }
      if (event.type === "ToolReturned") {
        const owner = toolAttribution(get, event, position)
        if (!owner) continue
        const text = event.error ?? event.content.filter(part => part.type === "text").map(part => part.text).join("\n")
        const media = event.error === null && event.content.some(part => part.type === "file")
        rows.push({ position, value: { turnId: owner.turnId, message: { role: "tool", callId: event.callId, providerId: owner.providerId, name: owner.name, text, ...(media ? { content: event.content } : {}), error: event.error !== null } } })
      }
      if (rows.length > limit) return { rows: rows.slice(0, limit), snapshot: selection.to, next: { ...selection, order, position: rows[limit - 1]!.position } }
    }
    if (!page.next) return { rows, snapshot: selection.to }
    after = page.next
  }
}).pipe(NativeAtom.setIdleTTL(0)), { input: agentLog.schema }))

// trajectory pages ordered turn-owned messages; history remains in the journal (platform/test/properties/turn-facts.ts).
export const trajectory: TrajectorySource<typeof Trajectory.Type[number]> = { revision: trajectoryRevision, legacyCursor: legacyTrajectoryCursor, range: (options = {}) => pages(JSON.stringify(options)) }
const messagePages = NativeAtom.family((identity: string): Atom<LogReadPage<typeof Conversation.Type[number]>> => Object.assign(NativeAtom.readable(get => {
  const page = get(trajectory.range(JSON.parse(identity) as TrajectoryRangeOptions))
  return { ...page, rows: page.rows.map(row => ({ position: row.position, value: row.value.message })) }
}).pipe(NativeAtom.setIdleTTL(0)), { input: agentLog.schema }))

// messages pages model messages without retaining a complete conversation array.
export const messages: TrajectorySource<typeof Conversation.Type[number]> = { selection: trajectoryLog.range, revision: trajectoryRevision, legacyCursor: legacyTrajectoryCursor, range: (options = {}) => messagePages(JSON.stringify(options)) }
