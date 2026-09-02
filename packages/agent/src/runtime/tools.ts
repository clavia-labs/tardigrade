import { intent, type Transition, type Intent } from "@clavia/tardigrade-core/reconciliation"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { toolReturned } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { eventEpochOf } from "@clavia/tardigrade-code/execution/turns"
import type { InvocationCancellation } from "@clavia/tardigrade-core/actor"
import type { Component, ComponentMachine } from "@clavia/tardigrade-core/actor"
import { incrementalComponent, legacyComponent } from "@clavia/tardigrade-core/actor"
import { Chunk, HashMap, Option } from "effect"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnViewFrom,
  type TurnProjectionState
} from "@clavia/tardigrade-code/execution/turn-projection"

// PendingCall identifies the head unanswered ToolCalled event.
export interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
  readonly epoch?: number
}

// Answer constructs the intent that records a tool result under the pending call's key.
export type Answer = (result: unknown) => Intent<never>

// Serve returns transitions for one call, an empty array while work remains pending, or undefined
// when the derived tool view does not contain the call.
export type Serve<R = never> = (
  call: PendingCall,
  log: ReadonlyArray<Event>,
  answer: Answer
) => ReadonlyArray<Transition<never, R>> | undefined

const str = (v: unknown): string => String(v ?? "")

// pendingCall returns the earliest unanswered ToolCalled event by time and call ID.
const pendingCall = (log: ReadonlyArray<Event>): PendingCall | undefined => {
  const answered = new Set(
    log.filter((e) => e.type === "ToolReturned").map((e) => str((e as { callId?: unknown }).callId))
  )
  const head = log
    .filter((e) => {
      if (e.type !== "ToolCalled" || answered.has(str((e as { callId?: unknown }).callId))) return false
      const turn = (e as { turn?: unknown }).turn
      return turn === undefined || turnTerminalOf(log, String(turn)) === undefined
    })
    .sort((a, b) => {
      const d = Number((a as { at?: unknown }).at ?? 0) - Number((b as { at?: unknown }).at ?? 0)
      const ai = str((a as { callId?: unknown }).callId)
      const bi = str((b as { callId?: unknown }).callId)
      return d !== 0 ? d : ai < bi ? -1 : 1
    })[0] as { callId?: unknown; name?: unknown; arguments?: unknown; turn?: unknown; epoch?: unknown } | undefined
  if (head === undefined) return undefined
  return {
    callId: str(head.callId),
    name: str(head.name),
    arguments: head.arguments,
    ...(head.turn === undefined ? {} : { turn: str(head.turn) }),
    ...(typeof head.epoch === "number" ? { epoch: head.epoch } : {})
  }
}

const unknownToolError = (name: string, offered: ReadonlyArray<{ readonly name: string }>): string => {
  const available = offered.map((tool) => tool.name)
  if (name.includes(".") && available.includes("execute")) {
    return `unknown tool: ${name}. Package methods run inside execute. Call execute with JavaScript such as \`return await ${name}({...})\`.`
  }
  return `unknown tool: ${name}. Call one of: ${available.join(", ")}.`
}

// toolsReactorFrom routes the head pending call through its derived tool view.
export const toolsReactorFrom = <R = never>(
  serve: Serve<R>,
  toolsFor: (log: ReadonlyArray<Event>, call: PendingCall) => ReadonlyArray<{ readonly name: string }>
): CompleteTransitionDerivation<R> => (log) => {
  const call = pendingCall(log)
  if (call === undefined) return []
  const stamp = call.turn === undefined ? {} : { turn: call.turn }
  const answering = (result: unknown): Intent<never> =>
    intent({
      key: `tr:${call.callId}`,
      ...(call.turn === undefined ? {} : {
        invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 }
      }),
      input: { callId: call.callId, result },
      events: (input, at) => [toolReturned({ callId: input.callId, result: input.result, ...stamp, at })]
    })

  const served = serve(call, log, answering)
  if (served === undefined) {
    return [answering({ error: unknownToolError(call.name, toolsFor(log, call)) })]
  }
  return served
}

// cancelTools settles every open tool call owned by the cancelled message invocation.
const toolCancellationTransitions = (
  calls: ReadonlyArray<string>,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never>> => calls.map((callId) => intent({
  key: `tr:${callId}`,
  input: { callId, cancellation },
  events: (input, at) => {
    const reason = input.cancellation.reason === undefined
      ? "cancelled"
      : `cancelled: ${input.cancellation.reason}`
    return [toolReturned({
      callId: input.callId,
      result: { error: reason },
      turn: input.cancellation.invocation.id,
      at
    })]
  }
}))

const cancelTools = (
  log: ReadonlyArray<Event>,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never>> => {
  if (cancellation.invocation.method !== "message") return []
  const answered = new Set(
    log.filter((event) => event.type === "ToolReturned")
      .map((event) => String((event as { readonly callId?: unknown }).callId))
  )
  const calls = log.flatMap((event) =>
    event.type === "ToolCalled" &&
      String((event as { readonly turn?: unknown }).turn) === cancellation.invocation.id &&
      eventEpochOf(event) === cancellation.invocation.epoch &&
      !answered.has(String((event as { readonly callId?: unknown }).callId))
      ? [String((event as { readonly callId?: unknown }).callId)]
      : []
  )
  return toolCancellationTransitions(calls, cancellation)
}

// toolsComponentFrom exposes tool dispatch and open-call cancellation through one component.
export const toolsComponentFrom = <V, R = never>(
  empty: V,
  serve: Serve<R>,
  toolsFor: (log: ReadonlyArray<Event>, call: PendingCall) => ReadonlyArray<{ readonly name: string }>
): Component<V, R> => {
  const dispatch = toolsReactorFrom(serve, toolsFor)
  return legacyComponent({
    name: "tools",
    cancel: cancelTools,
    derive: (log) => ({ view: empty, transitions: dispatch(log) })
  })
}

interface ProjectedTool<R = never> {
  readonly spec: { readonly name: string }
  readonly serve: Serve<R>
}

interface PendingRecord<R = never> {
  readonly call: PendingCall
  readonly offered: ReadonlyArray<ProjectedTool<R>>
  readonly log: Chunk.Chunk<Event>
  readonly order: number
}

interface IncrementalToolsState<R = never> {
  readonly child: unknown
  readonly turns: TurnProjectionState
  readonly nextOrder: number
  readonly pending: HashMap.HashMap<string, PendingRecord<R>>
  readonly offers: HashMap.HashMap<string, ReadonlyArray<ProjectedTool<R>>>
  readonly heads: HashMap.HashMap<string, Event>
  readonly thread?: Event
}

// incrementalToolsComponentFrom retains one scoped history per open call and the view that offered it.
export const incrementalToolsComponentFrom = <V, R = never>(
  empty: V,
  child: ComponentMachine<V, R>,
  toolsOf: (view: V) => ReadonlyArray<ProjectedTool<R>>
): Component<V, R> => incrementalComponent<IncrementalToolsState<R>, V, R>({
  name: "tools",
  initial: (): IncrementalToolsState => ({
    child: child.initial(),
    turns: initialTurnProjection(),
    nextOrder: 0,
    pending: HashMap.empty(),
    offers: HashMap.empty(),
    heads: HashMap.empty()
  }),
  step: (state, event) => {
    const eventTurn = String((event as { readonly turn?: unknown }).turn ?? "")
    let before: ReadonlyArray<ProjectedTool<R>> | undefined
    const offeredBefore = (): ReadonlyArray<ProjectedTool<R>> => {
      before ??= toolsOf(child.output(state.child).view)
      return before
    }
    const offers = event.type === "ModelCalled" && eventTurn !== ""
      ? HashMap.set(state.offers, eventTurn, offeredBefore())
      : state.offers
    const heads = event.type === "MessageReceived"
      ? HashMap.set(state.heads, String((event as { readonly id?: unknown }).id ?? ""), event)
      : state.heads
    const thread = event.type === "ThreadCreated" ? event : state.thread
    let pending: HashMap.HashMap<string, PendingRecord<R>> = HashMap.map(
      state.pending,
      (record): PendingRecord<R> => ({ ...record, log: Chunk.append(record.log, event) })
    )
    let nextOrder = state.nextOrder
    if (event.type === "ToolCalled") {
      const callId = str((event as { readonly callId?: unknown }).callId)
      if (!HashMap.has(pending, callId)) {
        const currentTurn = turnViewFrom(state.turns)
        const turn = (event as { readonly turn?: unknown }).turn
        const turnId = turn === undefined ? undefined : str(turn)
        const epoch = (event as { readonly epoch?: unknown }).epoch
        const call: PendingCall = {
          callId,
          name: str((event as { readonly name?: unknown }).name),
          arguments: (event as { readonly arguments?: unknown }).arguments,
          ...(turnId === undefined ? {} : { turn: turnId }),
          ...(typeof epoch === "number"
            ? { epoch }
            : {})
        }
        const prefix = [
          ...(thread === undefined ? [] : [thread]),
          ...(turnId === undefined
            ? []
            : currentTurn.length > 0 && String((currentTurn[0] as { readonly id?: unknown }).id) === turnId
              ? currentTurn
              : Option.match(HashMap.get(heads, turnId), { onNone: () => [], onSome: (head) => [head] }))
        ]
        const callOffer = turnId === undefined
          ? offeredBefore()
          : Option.getOrElse(HashMap.get(offers, turnId), offeredBefore)
        const record: PendingRecord<R> = {
          call,
          offered: callOffer,
          log: Chunk.fromIterable([...prefix, event]),
          order: nextOrder
        }
        pending = HashMap.set(pending, callId, record)
        nextOrder += 1
      }
    }
    if (event.type === "ToolReturned") {
      pending = HashMap.remove(pending, str((event as { readonly callId?: unknown }).callId))
    }
    if (event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled") {
      pending = HashMap.filter(pending, (record) =>
        record.call.turn !== eventTurn || (record.call.epoch ?? 0) !== eventEpochOf(event)
      )
    }
    return {
      child: child.step(state.child, event),
      turns: reduceTurnProjection(state.turns, event),
      nextOrder,
      pending,
      offers,
      heads,
      ...(thread === undefined ? {} : { thread })
    }
  },
  cancelState: (state, cancellation) => {
    if (cancellation.invocation.method !== "message") return []
    const calls = [...HashMap.values(state.pending)]
      .filter((record) =>
        record.call.turn === cancellation.invocation.id &&
        (record.call.epoch ?? 0) === cancellation.invocation.epoch
      )
      .map((record) => record.call.callId)
    return toolCancellationTransitions(calls, cancellation)
  },
  output: (state) => {
    let current: PendingRecord<R> | undefined
    for (const record of HashMap.values(state.pending)) {
      if (current === undefined || record.order < current.order) current = record
    }
    if (current === undefined) return { view: empty, transitions: [] }
    const tool = current.offered.find((candidate) => candidate.spec.name === current!.call.name)
    const log = Chunk.toReadonlyArray(current.log)
    const stamp = current.call.turn === undefined ? {} : { turn: current.call.turn }
    const answering = (result: unknown): Intent<never> => intent({
      key: `tr:${current!.call.callId}`,
      ...(current!.call.turn === undefined ? {} : {
        invocation: { method: "message", id: current!.call.turn, epoch: current!.call.epoch ?? 0 }
      }),
      input: { callId: current.call.callId, result },
      events: (input, at) => [toolReturned({ callId: input.callId, result: input.result, ...stamp, at })]
    })
    const transitions = tool?.serve(current.call, log, answering)
    return {
      view: empty,
      transitions: transitions ?? [answering({ error: unknownToolError(current.call.name, current.offered.map((tool) => tool.spec)) })]
    }
  }
})
