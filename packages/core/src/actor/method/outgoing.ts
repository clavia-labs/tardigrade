import { Clock, Effect, Schema } from "effect"
import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log"
import { methodEnvelopeOf } from "../../communication/envelope"
import { formatThreadAddress } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { Router } from "../../communication/router"
import { Self, effect, type Transition } from "../../reconciliation"
import type { ActorRef } from "../reference"
import type {
  ActorMethodDeclaration,
  ActorMethodInput,
  ActorMethodOutput,
  ActorMethods
} from "./definition"
import { actorMethodTimeoutOf } from "./definition"
import type { ActorMethodState } from "./state"
import type { ResponseReceived } from "./response"
import type { CallTimedOut } from "./timeout"

type MethodName<Methods extends ActorMethods> = Extract<keyof Methods, string>

// CallDispatched records that one durable method future was dispatched to its target.
export interface CallDispatched extends Event {
  readonly type: "CallDispatched"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly input: unknown
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

export const methodCallKeys: KeyFragment = {
  prefixes: ["mcall:"],
  keyOf: (event) => event.type === "CallDispatched"
    ? `mcall:${String((event as { readonly id?: unknown }).id)}`
    : undefined
}

export interface ActorCallOptions<
  Methods extends ActorMethods,
  Name extends MethodName<Methods>
> {
  readonly id: string
  readonly target: ActorRef<Methods>
  readonly method: Name
  readonly input: ActorMethodInput<Methods[Name]>
  readonly timeoutMs?: number
}

// ActorCall is one durable future and the transition still owed for it, if any.
export interface ActorCall<Output, R = never> {
  readonly id: string
  readonly method: string
  readonly target: ActorRef["address"]
  readonly state: ActorMethodState<Output>
  readonly transitions: ReadonlyArray<Transition<never, R>>
}

const terminalFor = (
  log: ReadonlyArray<Event>,
  method: string,
  id: string,
  target: string
): ResponseReceived | CallTimedOut | undefined => log.find((event) => {
  if (String((event as { readonly method?: unknown }).method) !== method) return false
  if (String((event as { readonly call?: unknown }).call) !== id) return false
  if (event.type === "CallTimedOut") {
    return String((event as { readonly target?: unknown }).target) === target
  }
  return event.type === "ResponseReceived" &&
    String((event as { readonly from?: unknown }).from) === target
}) as ResponseReceived | CallTimedOut | undefined

const canonicalJson = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry
    const record = entry as Readonly<Record<string, unknown>>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
  })

// actorCall projects a replay-safe outgoing method invocation and its current terminal state.
export const actorCall = <
  Methods extends ActorMethods,
  Name extends MethodName<Methods>
>(
  log: ReadonlyArray<Event>,
  options: ActorCallOptions<Methods, Name>
): ActorCall<ActorMethodOutput<Methods[Name]>, Router | Self> => {
  const target = formatThreadAddress(options.target.address)
  const declaration = options.target.methods[options.method] as ActorMethodDeclaration
  const response = terminalFor(log, options.method, options.id, target)
  if (response?.type === "CallTimedOut") {
    return {
      id: options.id,
      method: options.method,
      target: options.target.address,
      state: { status: "failed", error: `${options.method} timed out after ${response.timeoutMs}ms` },
      transitions: []
    }
  }
  if (response?.status === "completed") {
    try {
      const output = Schema.decodeUnknownSync(declaration.output)(response.output) as ActorMethodOutput<Methods[Name]>
      return { id: options.id, method: options.method, target: options.target.address, state: { status: "completed", output }, transitions: [] }
    } catch (failure) {
      return {
        id: options.id,
        method: options.method,
        target: options.target.address,
        state: { status: "failed", error: `invalid ${options.method} response: ${failure instanceof Error ? failure.message : String(failure)}` },
        transitions: []
      }
    }
  }
  if (response?.status === "failed") {
    return { id: options.id, method: options.method, target: options.target.address, state: { status: "failed", error: response.error ?? "actor method failed" }, transitions: [] }
  }

  const sent = log.find((event) =>
    event.type === "CallDispatched" &&
    String((event as { readonly id?: unknown }).id) === options.id
  ) as { readonly method?: unknown; readonly target?: unknown; readonly input?: unknown } | undefined
  if (sent !== undefined) {
    const drift = String(sent.method) !== options.method
      ? `method ${options.method} does not match recorded ${String(sent.method)}`
      : String(sent.target) !== target
        ? `target ${target} does not match recorded ${String(sent.target)}`
        : canonicalJson(sent.input) !== canonicalJson(options.input)
          ? "input does not match the recorded call"
          : undefined
    if (drift !== undefined) throw new Error(`actor call ${JSON.stringify(options.id)} drifted: ${drift}`)
    return { id: options.id, method: options.method, target: options.target.address, state: { status: "pending" }, transitions: [] }
  }

  const timeoutMs = options.timeoutMs === undefined ? declaration.timeoutMs : actorMethodTimeoutOf(options.timeoutMs)
  if (timeoutMs > declaration.timeoutMs) {
    throw new Error(`actor call timeoutMs cannot exceed ${options.method}'s declared ${declaration.timeoutMs}ms`)
  }

  const transition = effect({
    key: `mcall:${options.id}`,
    input: options,
    act: (current) => Effect.gen(function* () {
      const router = yield* Router
      const self = yield* Self
      const at = yield* Clock.currentTimeMillis
      const deadlineAt = at + timeoutMs
      if (!Number.isSafeInteger(deadlineAt)) return yield* Effect.die(new Error("actor call deadlineAt must be a safe integer"))
      yield* router.send(methodEnvelopeOf(
        linkOf(self, current.target.address),
        { method: current.method, id: current.id },
        declaration.eventOf({ id: current.id, input: current.input, at })
      ))
      return [{
        type: "CallDispatched",
        id: current.id,
        method: current.method,
        target: formatThreadAddress(current.target.address),
        input: current.input,
        timeoutMs,
        deadlineAt,
        at
      } satisfies CallDispatched]
    })
  })
  return { id: options.id, method: options.method, target: options.target.address, state: { status: "pending" }, transitions: [transition] }
}
