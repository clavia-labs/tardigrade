import type { CallDispatched, CallPlanned, CallSkipped, CancellationResult, CallTimedOut } from "./events"
import { Clock, Effect, Schema } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { Self } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/index"
import { formatThreadAddress } from "../transport/endpoint"
import { Router } from "../transport/router"
import { type ThreadLineage, invocationLinked, type InvocationLinked } from "./relations"
import { CANCELLATION_CONTROL_METHOD, cancellationMethodFor } from "./cancellation"

import type { ThreadTarget } from "../actor/reference"
import { decodeActorInvocationContext, type ActorInvocationContext, InvocationRef, sameInvocation, decodeInvocationCoordinate, invocationIdForKey, invocationCoordinateKey, invocationCoordinateOf, type InvocationCoordinate } from "./invocation"

import type { ActorMethodCancellation, ActorMethodDeclaration, ActorMethodInput, ActorMethodOutput, ActorMethods } from "../actor/method"
import type { ActorMethodState } from "./state"

import { invocationTerminalOf, invocationResultOf } from "./result"
import { sendInvocation } from "./send"
import { invocationTimeoutOf, prepareInvocation } from "./prepare"
import { outgoingKey, outgoingMatches, outgoingReference } from "./records-compat"

export { invocationLinked, type InvocationLinked } from "./relations"

type MethodName<Methods extends ActorMethods> = Extract<keyof Methods, string>

export const methodCallKeys: KeyFragment = {
  prefixes: ["mplan:", "mcall:", "mlink:"],
  keyOf: (event) => event.type === "CallPlanned"
    ? `mplan:${outgoingKey(event)}`
    : event.type === "CallDispatched" || event.type === "CallSkipped"
    ? `mcall:${outgoingKey(event)}`
    : event.type === "InvocationLinked"
      ? `mlink:${JSON.stringify([
          (event as unknown as InvocationLinked).parent.method,
          (event as unknown as InvocationLinked).parent.id,
          (event as unknown as InvocationLinked).parent.epoch,
          (event as unknown as InvocationLinked).child.invocation.method,
          (event as unknown as InvocationLinked).child.invocation.id,
          (event as unknown as InvocationLinked).child.invocation.epoch,
          (event as unknown as InvocationLinked).target
        ])}`
      : undefined
}

export type ActorCallOptions<
  Methods extends ActorMethods,
  Name extends MethodName<Methods>
> = {
  readonly target: ThreadTarget<Methods>
  readonly method: Name
  readonly input: ActorMethodInput<Methods[Name]>
  readonly context?: ActorInvocationContext
  readonly timeoutMs?: number
  readonly lineage?: ThreadLineage
} & (
  | { readonly id: string; readonly epoch?: number; readonly parent?: never; readonly key?: never }
  | { readonly parent: InvocationCoordinate; readonly key: string; readonly id?: never; readonly epoch?: never }
)

// ActorCall is one durable future and the transition still owed for it, if any.
export interface ActorCall<Output, R = never> {
  readonly reference: InvocationCoordinate
  readonly id: string
  readonly method: string
  readonly invocation: InvocationRef
  readonly context?: ActorInvocationContext
  readonly target: ThreadTarget["address"]
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
  readonly target: ThreadTarget<Methods>
  readonly invocation: InvocationRef
}

const canonicalJson = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry
    const record = entry as Readonly<Record<string, unknown>>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]))
  })

const firstMismatch = (
  ...checks: ReadonlyArray<readonly [mismatch: boolean, message: string]>
): string | undefined => checks.find(([mismatch]) => mismatch)?.[1]

// actorCall projects a replay-safe outgoing method invocation and its current terminal state.
export const actorCall = <
  Methods extends ActorMethods,
  Name extends MethodName<Methods>
>(
  log: ReadonlyArray<Event>,
  request: ActorCallOptions<Methods, Name>
): ActorCallFor<Methods[Name], ActorMethodOutput<Methods[Name]>, Router | Self> => {
  const parent = request.parent === undefined ? undefined : decodeInvocationCoordinate(request.parent)
  const options = parent === undefined ? { ...request, id: request.id! } : {
    ...request,
    id: invocationIdForKey(parent, request.key!),
    context: request.context ?? { invocation: parent.invocation }
  }
  if (parent !== undefined) {
    if (options.context === undefined || !sameInvocation(options.context.invocation, parent.invocation)) {
      throw new Error("idempotency parent does not match the caller invocation context")
    }
    const recorded = log.find((event) =>
      (event.type === "CallPlanned" || event.type === "CallDispatched") && event.id === options.id
    ) as CallPlanned | CallDispatched | undefined
    if (recorded !== undefined) {
      const drift = firstMismatch(
        [recorded.target !== formatThreadAddress(options.target.address), "target does not match the recorded call"],
        [recorded.method !== options.method, "method does not match the recorded call"],
        [canonicalJson(recorded.input) !== canonicalJson(options.input), "input does not match the recorded call"]
      )
      if (drift !== undefined) throw new Error(`idempotency key ${JSON.stringify(request.key)} drifted: ${drift}`)
    }
  }
  const target = formatThreadAddress(options.target.address)
  const declaration = options.target.methods[options.method] as ActorMethodDeclaration
  const invocation: InvocationRef = {
    method: options.method,
    id: options.id,
    epoch: options.epoch ?? 0
  }
  Schema.decodeSync(InvocationRef)(invocation)
  const reference = invocationCoordinateOf(options.target.address, invocation)
  if (options.context !== undefined) {
    decodeActorInvocationContext(options.context)
  }
  const result = (
    call: Omit<ActorCall<ActorMethodOutput<Methods[Name]>, Router | Self>, "invocation" | "reference">
  ): ActorCallFor<Methods[Name], ActorMethodOutput<Methods[Name]>, Router | Self> => ({
    ...call,
    invocation,
    reference,
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
  const response = invocationTerminalOf(log, reference)
  if (response !== undefined) {
    return result({
      id: options.id,
      method: options.method,
      target: options.target.address,
      state: invocationResultOf(response, declaration.output) as ActorMethodState<ActorMethodOutput<Methods[Name]>>,
      transitions: []
    })
  }

  const sent = log.find((event) =>
    event.type === "CallDispatched" &&
    outgoingMatches(event, reference)
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

  const timeoutMs = invocationTimeoutOf(declaration, options.timeoutMs)

  const planned = log.find((event) =>
    event.type === "CallPlanned" && outgoingMatches(event, reference)
  ) as CallPlanned | undefined
  if (planned === undefined) {
    return result({
      id: options.id,
      method: options.method,
      target: options.target.address,
      state: { status: "pending" },
      transitions: [intent({
        key: `mplan:${invocationCoordinateKey(reference)}`,
        ...(options.context === undefined ? {} : { invocation: options.context.invocation }),
        input: options,
        events: (current, at) => {
          const { context } = prepareInvocation({
            reference, method: declaration, input: current.input, at, timeoutMs,
            ...(current.context === undefined ? {} : { parent: current.context })
          })
          const plan: CallPlanned = {
            type: "CallPlanned",
            reference,
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
                ...(current.lineage === undefined ? {} : { lineage: current.lineage }),
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
    key: `mcall:${outgoingKey(planned)}`,
    ...(options.context === undefined ? {} : { invocation: options.context.invocation }),
    input: options,
    act: (current) => Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis
      if (deadlineAt <= at) {
        return [
          {
            type: "CallSkipped",
            ...outgoingReference(planned),
            id: current.id,
            method: current.method,
            target: formatThreadAddress(current.target.address),
            deadlineAt,
            at
          } satisfies CallSkipped,
          {
            type: "CallTimedOut",
            ...outgoingReference(planned),
            call: current.id,
            method: current.method,
            target: formatThreadAddress(current.target.address),
            timeoutMs,
            deadlineAt,
            at
          } satisfies CallTimedOut
        ]
      }
      yield* sendInvocation({ target: current.target.address, context: planned.context,
        event: prepareInvocation({ reference, method: declaration, input: planned.input, at, context: planned.context }).event,
        ...(current.lineage === undefined ? {} : { lineage: current.lineage }) })
      const dispatched: CallDispatched = {
        type: "CallDispatched",
        ...outgoingReference(planned),
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
