import { intent, type Transition, type Intent, type Reactor } from "@clavia/tardigrade-core/reconciliation"
import { toolReturned } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"

// PendingCall identifies the head unanswered ToolCalled event.
export interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
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
    .filter((e) => e.type === "ToolCalled" && !answered.has(str((e as { callId?: unknown }).callId)))
    .sort((a, b) => {
      const d = Number((a as { at?: unknown }).at ?? 0) - Number((b as { at?: unknown }).at ?? 0)
      const ai = str((a as { callId?: unknown }).callId)
      const bi = str((b as { callId?: unknown }).callId)
      return d !== 0 ? d : ai < bi ? -1 : 1
    })[0] as { callId?: unknown; name?: unknown; arguments?: unknown; turn?: unknown } | undefined
  if (head === undefined) return undefined
  return {
    callId: str(head.callId),
    name: str(head.name),
    arguments: head.arguments,
    ...(head.turn === undefined ? {} : { turn: str(head.turn) })
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
      input: { callId: call.callId, result },
      events: (input, at) => [toolReturned({ callId: input.callId, result: input.result, ...stamp, at })]
    })

  const served = serve(call, log, answering)
  if (served === undefined) {
    return [answering({ error: unknownToolError(call.name, toolsFor(log, call)) })]
  }
  return served
}
