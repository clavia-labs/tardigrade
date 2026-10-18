import type { ObservedCoreEvent, RecordMetadata } from "@clavia/tardigrade-core"
import type { Atom } from "effect/unstable/reactivity"
import type { Event } from "@clavia/tardigrade-agent/contracts/events"
import type { spendState } from "@clavia/tardigrade-agent/atoms/durable/spend"

type SpendState = Atom.Type<typeof spendState>

// reduceSpend models array-based spend transitions for native collection comparison (../properties/actors.ts).
export function reduceSpend(state: SpendState, event: Event | ObservedCoreEvent, metadata: RecordMetadata): SpendState {
  if (metadata.recordedAt !== undefined) {
    let updated: Array<SpendState["timeSpend"][number]> | undefined
    for (const timer of state.timers) {
      if (timer.startedAt === null) continue
      const turn = state.timeSpend[timer.index]!
      const ms = Math.max(0, metadata.recordedAt - timer.startedAt)
      if (turn.ms === ms) continue
      updated ??= state.timeSpend.slice()
      updated[timer.index] = { ...turn, ms }
    }
    if (updated) state = { ...state, timeSpend: updated }
  }
  if (event.type === "TurnRequested") {
    if (state.toolSpend.some(turn => turn.turnId === event.turnId)) return state
    const turnId = event.turnId
    return {
      ...state, turns: [...state.turns, turnId],
      timers: [...state.timers, { turnId, index: state.timeSpend.length, startedAt: metadata.recordedAt ?? null }],
      timeSpend: [...state.timeSpend, { turnId, ms: metadata.recordedAt === undefined ? null : 0 }],
      toolSpend: [...state.toolSpend, { turnId, count: 0 }],
      tokenSpend: [...state.tokenSpend, { turnId, input: 0, output: 0 }],
      usdSpend: [...state.usdSpend, { turnId, usd: 0 }],
    }
  }
  if (event.type === "ModelCalled") {
    const turnId = event.purpose === "inference" ? event.turnId : state.turns[0]
    if (turnId === undefined || state.models.some(call => call.callId === event.callId)) return state
    return { ...state, models: [...state.models, { callId: event.callId, turnId }] }
  }
  if (event.type === "ModelReturned") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    const usage = event.usage
    return {
      ...state, models: state.models.filter(value => value !== call),
      tools: event.purpose === "inference" ? [...state.tools, ...event.toolCalls.map(tool => ({ callId: tool.callId, turnId: call.turnId }))] : state.tools,
      tokenSpend: usage ? state.tokenSpend.map(turn => turn.turnId === call.turnId
        ? { ...turn, input: turn.input + (usage.input ?? 0), output: turn.output + (usage.output ?? 0) } : turn) : state.tokenSpend,
      usdSpend: state.usdSpend.map(turn => turn.turnId === call.turnId
        ? { ...turn, usd: turn.usd === null || usage?.usd == null ? null : turn.usd + usage.usd } : turn),
    }
  }
  if (event.type === "ToolCalled" || event.type === "ToolReturned") {
    const call = state.tools.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      ...state, tools: state.tools.filter(value => value !== call),
      toolSpend: event.type === "ToolCalled" && event.counted
        ? state.toolSpend.map(turn => turn.turnId === call.turnId ? { ...turn, count: turn.count + 1 } : turn) : state.toolSpend,
    }
  }
  if (event.type === "CompactionFailed" || event.type === "ModelFailed") {
    const call = state.models.find(call => call.callId === event.callId)
    if (!call) return state
    return {
      ...state, models: state.models.filter(value => value !== call),
      usdSpend: state.usdSpend.map(turn => turn.turnId === call.turnId ? { ...turn, usd: null } : turn),
    }
  }
  if (event.type !== "TurnSettled") return state
  const timer = state.timers.find(timer => timer.turnId === event.turnId)
  if (timer && (metadata.recordedAt === undefined || timer.startedAt === null) && state.timeSpend[timer.index]!.ms !== null) {
    const timeSpend = state.timeSpend.slice()
    timeSpend[timer.index] = { turnId: event.turnId, ms: null }
    state = { ...state, timeSpend }
  }
  return {
    ...state, turns: state.turns.filter(turnId => turnId !== event.turnId),
    timers: state.timers.filter(timer => timer.turnId !== event.turnId),
    models: state.models.filter(call => call.turnId !== event.turnId),
    tools: state.tools.filter(call => call.turnId !== event.turnId),
    usdSpend: state.models.some(call => call.turnId === event.turnId)
      ? state.usdSpend.map(turn => turn.turnId === event.turnId ? { ...turn, usd: null } : turn) : state.usdSpend,
  }
}
