import { intent, type Transition, type Intent, type Reactor } from "@clavia/tardigrade-core/reconciliation"
import { toolReturned } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnTerminalOf } from "@clavia/tardigrade-code/execution/turns"
import { eventEpochOf } from "@clavia/tardigrade-code/execution/turns"
import type { InvocationCancellation } from "@clavia/tardigrade-core/actor"
import type { Component } from "@clavia/tardigrade-core/actor"

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
): Reactor<R> => (log) => {
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
  return calls.map((callId) => intent({
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
}

// toolsComponentFrom exposes tool dispatch and open-call cancellation through one component.
export const toolsComponentFrom = <V, R = never>(
  empty: V,
  serve: Serve<R>,
  toolsFor: (log: ReadonlyArray<Event>, call: PendingCall) => ReadonlyArray<{ readonly name: string }>
): Component<V, R> => {
  const dispatch = toolsReactorFrom(serve, toolsFor)
  return {
    name: "tools",
    cancel: cancelTools,
    derive: (log) => ({ view: empty, transitions: dispatch(log) })
  }
}
