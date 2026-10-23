import { atom, EventLog, RuntimeError, type Getter } from "@clavia/tardigrade-core"
import { eventLogContext } from "@clavia/tardigrade-core/services/event-log"
import { initialStateSeed } from "@clavia/tardigrade-core/initialise"
import { recordEvent } from "@clavia/tardigrade-core/runtime/record"
import { Context, Schema } from "effect"
import { Event } from "../contracts/events"

// legacyTrajectorySeed detects state-only conversation seeds whose source messages are unavailable.
export const legacyTrajectorySeed = atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const replay = get(Context.get(context, EventLog).replay)
  const seed = replay.originSeed ? replay.originSeed.value : initialStateSeed(replay.read(0))
  const inference = seed?.state.get("agent.inference.active") ?? seed?.state.get("agent.inference.state")
  const compaction = seed?.state.get("agent.compaction.state")
  const hasTurns = typeof inference === "object" && inference !== null && "turns" in inference && Array.isArray(inference.turns) && inference.turns.length > 0
  const hasSummary = typeof compaction === "object" && compaction !== null && (("origin" in compaction && typeof compaction.origin === "number") || ("through" in compaction && typeof compaction.through === "number" && compaction.through > 0) || ("summary" in compaction && typeof compaction.summary === "string" && compaction.summary.length > 0))
  return (seed?.state.has("agent.trajectory") ?? false) || hasTurns || hasSummary
})

// legacyToolAttribution retains pending model owners and the selected tool's metadata while scanning an old prefix.
export function legacyToolAttribution(get: Getter, callId: string, before: number) {
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const replay = get(Context.get(context, EventLog).replay)
  const accepts = Schema.is(Event)
  const models = new Map<string, string>()
  let owner: { readonly turnId: string; readonly providerId: string; readonly name: string } | undefined
  let position = 0
  for (const record of replay.read(0)) {
    if (position++ >= before) break
    const event = recordEvent(record)
    if (!accepts(event)) continue
    if (event.type === "ModelCalled" && event.purpose === "inference") models.set(event.callId, event.turnId)
    if (event.type === "ModelReturned" && event.purpose === "inference") {
      const turnId = models.get(event.callId)
      const call = event.toolCalls.find(call => call.callId === callId)
      if (turnId !== undefined && call) owner = { turnId, providerId: call.providerId, name: call.name }
      models.delete(event.callId)
    }
    if (event.type === "ModelFailed") models.delete(event.callId)
    if (event.type === "TurnSettled") for (const [id, turnId] of models) if (turnId === event.turnId) models.delete(id)
  }
  return owner
}

// legacyTrajectoryCursor resolves an ordinal compaction boundary without materializing the preceding messages.
export function legacyTrajectoryCursor(get: Getter, through: number): number {
  if (through === 0) return 0
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const replay = get(Context.get(context, EventLog).replay)
  const accepts = Schema.is(Event)
  const models = new Map<string, string>()
  let count = 0
  let position = 0
  for (const record of replay.read(0)) {
    const event = recordEvent(record)
    let entry = false
    if (accepts(event)) {
      if (event.type === "TurnRequested") entry = true
      if (event.type === "ModelCalled" && event.purpose === "inference") models.set(event.callId, event.turnId)
      if (event.type === "ModelReturned" && event.purpose === "inference") { entry = models.has(event.callId); models.delete(event.callId) }
      if (event.type === "ModelFailed") models.delete(event.callId)
      if (event.type === "TurnSettled") for (const [id, turnId] of models) if (turnId === event.turnId) models.delete(id)
      if (event.type === "ToolReturned") entry = (event.tool !== undefined && event.turnId !== undefined) || legacyToolAttribution(get, event.callId, position) !== undefined
    }
    position++
    if (entry && ++count === through) return position
  }
  throw new RuntimeError("Compaction boundary exceeds available trajectory history")
}
