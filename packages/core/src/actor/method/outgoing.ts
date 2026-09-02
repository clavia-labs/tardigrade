import { Clock, Effect, Schema } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../../log"
import { methodEnvelopeOf } from "../../communication/envelope"
import { formatThreadAddress } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { Router } from "../../communication/router"
import type { ThreadLineage } from "../../thread"
import {
  CANCELLATION_CONTROL_METHOD,
  type CancellationResult,
  cancellationMethodFor
} from "./cancellation"
import type { ActorRef } from "../reference"
import {
  ActorInvocationSchema,
  decodeActorInvocationContext,
  type ActorInvocation,
  type ActorInvocationContext
} from "./call"
import type {
  ActorMethodCancellation,
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
  readonly epoch?: number
  readonly parent?: ActorInvocation
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

// CallPlanned records one outgoing invocation before it can become externally visible.
export interface CallPlanned extends Event {
  readonly type: "CallPlanned"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly input: unknown
  readonly context: ActorInvocationContext
  readonly timeoutMs: number
  readonly at: number
}

// CallSkipped records that an inherited deadline prevented external publication.
export interface CallSkipped extends Event {
  readonly type: "CallSkipped"
  readonly id: string
  readonly method: string
  readonly target: string
  readonly deadlineAt: number
  readonly at: number
}

// InvocationLinked records one durable parent-child edge in an actor's invocation tree.
export interface InvocationLinked extends Event {
  readonly type: "InvocationLinked"
  readonly parent: ActorInvocation
  readonly child: ActorInvocationContext
  readonly target: string
  readonly lineage?: ThreadLineage
  readonly at: number
}

export const invocationLinked = (fields: {
  readonly parent: ActorInvocation
  readonly child: ActorInvocationContext
  readonly target: string
  readonly lineage?: ThreadLineage
  readonly at: number
}): InvocationLinked =>
  ({ type: "InvocationLinked", ...fields })

export const methodCallKeys: KeyFragment = {
  prefixes: ["mplan:", "mcall:", "mlink:"],
  keyOf: (event) => event.type === "CallPlanned"
    ? `mplan:${String((event as { readonly id?: unknown }).id)}`
    : event.type === "CallDispatched" || event.type === "CallSkipped"
    ? `mcall:${String((event as { readonly id?: unknown }).id)}`
    : event.type === "InvocationLinked"
      ? `mlink:${JSON.stringify([
          (event as unknown as InvocationLinked).parent.method,
          (event as unknown as InvocationLinked).parent.id,
          (event as unknown as InvocationLinked).parent.epoch,
          (event as unknown as InvocationLinked).child.invocation.method,
          (event as unknown as InvocationLinked).child.invocation.id,
          (event as unknown as InvocationLinked).child.invocation.epoch
        ])}`
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
  readonly epoch?: number
  readonly context?: ActorInvocationContext
  readonly timeoutMs?: number
}

// ActorCall is one durable future and the transition still owed for it, if any.
export interface ActorCall<Output, R = never> {
  readonly id: string
  readonly method: string
  readonly invocation: ActorInvocation
  readonly context?: ActorInvocationContext
  readonly target: ActorRef["address"]
  readonly state: ActorMethodState<Output>
  readonly transitions: ReadonlyArray<Transition<never, R>>
}

export interface ActorCancellationOptions {
  readonly id: string
  readonly reason?: string
  readonly timeoutMs?: number
}

export type CancellableActorCall<Output, R = never> = ActorCall<Output, R> & {
  readonly cancel: (options: ActorCancellationOptions) => ActorCall<CancellationResult, R>
}

type ActorCallFor<Method extends ActorMethodDeclaration, Output, R> =
  Method extends { readonly cancellation: ActorMethodCancellation }
    ? CancellableActorCall<Output, R>
    : ActorCall<Output, R>

export interface CancelInvocationOptions<Methods extends ActorMethods> extends ActorCancellationOptions {
  readonly target: ActorRef<Methods>
  readonly invocation: ActorInvocation
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

const firstMismatch = (
  ...checks: ReadonlyArray<readonly [mismatch: boolean, message: string]>
): string | undefined => checks.find(([mismatch]) => mismatch)?.[1]

const terminalStateOf = <Output>(
  terminal: ResponseReceived | CallTimedOut,
  method: string,
  output: Schema.ConstraintDecoder<unknown>
): ActorMethodState<Output> => {
  if (terminal.type === "CallTimedOut") {
    return { status: "failed", error: `${method} timed out after ${terminal.timeoutMs}ms` }
  }
  if (terminal.status === "failed") {
    return { status: "failed", error: terminal.error ?? "actor method failed" }
  }
  if (terminal.status === "cancelled") {
    return {
      status: "cancelled",
      cause: terminal.cause ?? "requested",
      ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
      ...(terminal.deadlineAt === undefined ? {} : { deadlineAt: terminal.deadlineAt })
    }
  }
  try {
    return { status: "completed", output: Schema.decodeUnknownSync(output)(terminal.output) as Output }
  } catch (failure) {
    return {
      status: "failed",
      error: `invalid ${method} response: ${failure instanceof Error ? failure.message : String(failure)}`
    }
  }
}

// actorCall projects a replay-safe outgoing method invocation and its current terminal state.
export const actorCall = <
  Methods extends ActorMethods,
  Name extends MethodName<Methods>
>(
  log: ReadonlyArray<Event>,
  options: ActorCallOptions<Methods, Name>
): ActorCallFor<Methods[Name], ActorMethodOutput<Methods[Name]>, Router | Self> => {
  const target = formatThreadAddress(options.target.address)
  const declaration = options.target.methods[options.method] as ActorMethodDeclaration
  const invocation: ActorInvocation = {
    method: options.method,
    id: options.id,
    epoch: options.epoch ?? 0
  }
  Schema.decodeSync(ActorInvocationSchema)(invocation)
  if (options.context !== undefined) {
    decodeActorInvocationContext(options.context)
  }
  const result = (
    call: Omit<ActorCall<ActorMethodOutput<Methods[Name]>, Router | Self>, "invocation">
  ): ActorCallFor<Methods[Name], ActorMethodOutput<Methods[Name]>, Router | Self> => ({
    ...call,
    invocation,
    ...(options.context === undefined ? {} : { context: options.context }),
    ...(declaration.cancellation === undefined
      ? {}
      : {
          cancel: (cancellation: ActorCancellationOptions) => cancelInvocation(log, {
            ...cancellation,
            target: options.target,
            invocation
          })
        })
  }) as ActorCallFor<Methods[Name], ActorMethodOutput<Methods[Name]>, Router | Self>
  const response = terminalFor(log, options.method, options.id, target)
  if (response !== undefined) {
    return result({
      id: options.id,
      method: options.method,
      target: options.target.address,
      state: terminalStateOf<ActorMethodOutput<Methods[Name]>>(response, options.method, declaration.output),
      transitions: []
    })
  }

  const sent = log.find((event) =>
    event.type === "CallDispatched" &&
    String((event as { readonly id?: unknown }).id) === options.id
  ) as {
    readonly method?: unknown
    readonly target?: unknown
    readonly input?: unknown
    readonly epoch?: unknown
    readonly parent?: unknown
  } | undefined
  if (sent !== undefined) {
    const drift = firstMismatch(
      [String(sent.method) !== options.method, `method ${options.method} does not match recorded ${String(sent.method)}`],
      [String(sent.target) !== target, `target ${target} does not match recorded ${String(sent.target)}`],
      [Number(sent.epoch ?? 0) !== invocation.epoch, `epoch ${invocation.epoch} does not match recorded ${String(sent.epoch ?? 0)}`],
      [canonicalJson(sent.parent) !== canonicalJson(options.context?.invocation), "parent invocation does not match the recorded call"],
      [canonicalJson(sent.input) !== canonicalJson(options.input), "input does not match the recorded call"]
    )
    if (drift !== undefined) throw new Error(`actor call ${JSON.stringify(options.id)} drifted: ${drift}`)
    return result({ id: options.id, method: options.method, target: options.target.address, state: { status: "pending" }, transitions: [] })
  }

  const timeoutMs = options.timeoutMs === undefined ? declaration.timeoutMs : actorMethodTimeoutOf(options.timeoutMs)
  if (timeoutMs > declaration.timeoutMs) {
    throw new Error(`actor call timeoutMs cannot exceed ${options.method}'s declared ${declaration.timeoutMs}ms`)
  }

  const planned = log.find((event) =>
    event.type === "CallPlanned" && String((event as { readonly id?: unknown }).id) === options.id
  ) as CallPlanned | undefined
  if (planned === undefined) {
    return result({
      id: options.id,
      method: options.method,
      target: options.target.address,
      state: { status: "pending" },
      transitions: [intent({
        key: `mplan:${options.id}`,
        ...(options.context === undefined ? {} : { invocation: options.context.invocation }),
        input: options,
        events: (current, at) => {
          const localDeadlineAt = at + timeoutMs
          if (!Number.isSafeInteger(localDeadlineAt)) {
            throw new Error("actor call deadlineAt must be a safe integer")
          }
          const deadlineAt = current.context?.deadlineAt === undefined
            ? localDeadlineAt
            : Math.min(current.context.deadlineAt, localDeadlineAt)
          const context: ActorInvocationContext = {
            invocation,
            ...(current.context === undefined ? {} : { parent: current.context.invocation }),
            deadlineAt
          }
          const plan: CallPlanned = {
            type: "CallPlanned",
            id: current.id,
            method: current.method,
            target: formatThreadAddress(current.target.address),
            input: current.input,
            context,
            timeoutMs,
            at
          }
          return current.context === undefined
            ? [plan]
            : [plan, invocationLinked({
                parent: current.context.invocation,
                child: context,
                target,
                at
              })]
        }
      })]
    })
  }
  const planDrift = firstMismatch(
    [planned.method !== options.method, `method ${options.method} does not match planned ${planned.method}`],
    [planned.target !== target, `target ${target} does not match planned ${planned.target}`],
    [canonicalJson(planned.input) !== canonicalJson(options.input), "input does not match the planned call"],
    [canonicalJson(planned.context.parent) !== canonicalJson(options.context?.invocation), "parent invocation does not match the planned call"],
    [planned.context.invocation.epoch !== invocation.epoch, `epoch ${invocation.epoch} does not match planned ${planned.context.invocation.epoch}`]
  )
  if (planDrift !== undefined) throw new Error(`actor call ${JSON.stringify(options.id)} drifted: ${planDrift}`)
  if (planned.context.deadlineAt === undefined) {
    throw new Error(`actor call ${JSON.stringify(options.id)} plan carries no deadline`)
  }
  const deadlineAt = planned.context.deadlineAt

  const transition = effect({
    key: `mcall:${options.id}`,
    ...(options.context === undefined ? {} : { invocation: options.context.invocation }),
    input: options,
    act: (current) => Effect.gen(function* () {
      const router = yield* Router
      const self = yield* Self
      const at = yield* Clock.currentTimeMillis
      if (deadlineAt <= at) {
        return [
          {
            type: "CallSkipped",
            id: current.id,
            method: current.method,
            target: formatThreadAddress(current.target.address),
            deadlineAt,
            at
          } satisfies CallSkipped,
          {
            type: "CallTimedOut",
            call: current.id,
            method: current.method,
            target: formatThreadAddress(current.target.address),
            timeoutMs,
            deadlineAt,
            at
          } satisfies CallTimedOut
        ]
      }
      yield* router.send(methodEnvelopeOf(
        linkOf(self, current.target.address),
        planned.context,
        declaration.eventOf({ ...planned.context, input: planned.input, at })
      ))
      const dispatched: CallDispatched = {
        type: "CallDispatched",
        id: current.id,
        method: current.method,
        target: formatThreadAddress(current.target.address),
        input: current.input,
        ...(invocation.epoch === 0 ? {} : { epoch: invocation.epoch }),
        ...(planned.context.parent === undefined ? {} : { parent: planned.context.parent }),
        timeoutMs,
        deadlineAt,
        at
      }
      return [dispatched]
    })
  })
  return result({ id: options.id, method: options.method, target: options.target.address, state: { status: "pending" }, transitions: [transition] })
}

// cancelInvocation projects the durable core control call paired with one target invocation.
export const cancelInvocation = <Methods extends ActorMethods>(
  log: ReadonlyArray<Event>,
  options: CancelInvocationOptions<Methods>
): ActorCall<CancellationResult, Router | Self> => {
  const method = cancellationMethodFor(options.target.methods)
  return actorCall(log, {
    id: options.id,
    target: {
      address: options.target.address,
      methods: { [CANCELLATION_CONTROL_METHOD]: method }
    },
    method: CANCELLATION_CONTROL_METHOD,
    input: {
      invocation: options.invocation,
      ...(options.reason === undefined ? {} : { reason: options.reason })
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  })
}
