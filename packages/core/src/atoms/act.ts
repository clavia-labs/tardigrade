import { incrementalDecoder } from "./incremental/decode"
import { Context, Effect, Layer, Schema, Option } from "effect"
import { atom, type Atom } from "./atom"
import { EventLog, eventLogContext } from "../services/event-log"
import { effectKey, EffectRef, EffectCancelled, Cancelled, PromiseTimedOut, ExecutionHandle, RuntimeError, ExecutionResult } from "../runtime/effects"
import { type EffectRequest, EffectAcceptance, EffectSettled, PromiseSettled } from "../runtime/events"
import { EffectExecution } from "../services/effect-execution"

export interface ActService<Name extends string> {
  readonly act: Name
}

export type ActState<Value, Failure> =
  | { readonly status: "pending" }
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: Failure }

const DeferredType = Symbol("DeferredAct")
export interface DeferredAct {
  readonly [DeferredType]: true
  readonly handle: ExecutionHandle
}

export interface ActRequest<Value, Failure, Services> {
  // origin identifies the journal event that made this invocation ready (quint/checkpoint/acceptanceBinding.qnt, recoveryEquivalent). Omission identifies a startup invocation scoped to its atom and act.
  readonly origin?: number
  readonly request: EffectRequest
  readonly kind: "act"
  readonly identity: object
  readonly execute: Effect.Effect<ExecutionResult, Schema.Json, Services | EffectExecution>
  // onRequested derives domain events committed with durable acceptance; callbacks must be pure.
  onRequested?(ref: EffectRef): readonly object[]
  // onDeferred derives domain events committed with the submitted handle; callbacks must be pure.
  onDeferred?(handle: ExecutionHandle, ref: EffectRef): readonly object[]
  // onSettled derives domain events committed with the terminal decision; handle identifies deferred completion and callbacks must be pure.
  onSettled?(result: Exclude<ActState<Value, Failure | Cancelled | PromiseTimedOut>, { status: "pending" }>, ref: EffectRef, handle?: ExecutionHandle): readonly object[]
  readonly ref: Atom<EffectRef | undefined>
  // result exposes cancellation as a rejected Cancelled value delivered through onSettled (quint/terminalDelivery.qnt, deliverySound, callbackAtMostOnce).
  readonly result: Atom<ActState<Value, Failure | Cancelled | PromiseTimedOut>>
}

export interface ActCancellation {
  readonly request: EffectRequest
  readonly ref: EffectRef
  readonly reason: Schema.Json
  readonly handle?: ExecutionHandle
}

interface ImplementationService {
  readonly execute: (input: Schema.Json, ref: EffectRef) => Effect.Effect<ExecutionResult, Schema.Json, EffectExecution>
  readonly cancel: (request: ActCancellation, execution: Pick<typeof EffectExecution.Service, "get" | "cancel">) => Effect.Effect<void, Error>
}

// cancelAct dispatches idempotent cleanup using durable invocation data rather than proposal closures.
export const cancelAct = (request: ActCancellation, execution: Pick<typeof EffectExecution.Service, "get" | "cancel">): Effect.Effect<void, Error> => Effect.gen(function* () {
  // @effect-diagnostics-next-line serviceNotAsClass:off
  const service = Context.Service<ActService<string>, ImplementationService>(`experimental/act/${request.request.act}`)
  const implementation = Context.getOption(yield* Effect.context<never>(), service)
  if (Option.isNone(implementation)) return yield* Effect.fail(new RuntimeError(`Missing cancellation implementation: ${request.request.act}`))
  yield* implementation.value.cancel(request, execution)
})

// actInputs holds request inputs that request() decoded against their act's input schema and checked as JSON.
export const actInputs = new WeakSet<object>()

// act defines typed durable work whose implementation is supplied by a layer. Implementations must tolerate redelivery with the same reference after a crash.
// Cancellation handlers must tolerate repeated cleanup after reopening; deferred submissions use EffectExecution.submit to retain handles before interruption.
export function act<const Name extends string, Input extends Schema.Json, Value extends Schema.Json, Failure extends Schema.Json>(options: {
  readonly name: Name
  readonly input: Schema.Schema<Input>
  readonly success: Schema.Schema<Value>
  readonly failure: Schema.Schema<Failure>
}) {
  if (!options.name) throw new Error("Act name must not be empty")
  const inputSchema = Schema.toType(options.input)
  const successSchema = Schema.toType(options.success)
  const failureSchema = Schema.toType(options.failure)
  const decodeSuccess = Schema.decodeUnknownSync(successSchema)
  const decodeFailure = Schema.decodeUnknownSync(failureSchema)
  // decodeInput freezes what request builds, since prepareRequest freezes request inputs regardless; execute hands implementations unfrozen containers and reuses the request's.
  const decodeInput = incrementalDecoder(inputSchema)
  // Implementation uses the act name as its service identity across independently constructed definitions.
  // @effect-diagnostics-next-line serviceNotAsClass:off
  const Implementation = Context.Service<ActService<Name>, ImplementationService>(`experimental/act/${options.name}`)

  const layer = <Services, CancellationServices = never>(implement: (input: Input, context: { readonly ref: EffectRef; readonly signal: AbortSignal }) => Effect.Effect<Value | DeferredAct, Failure, Services>, cancellation?: { readonly cancel: (input: Input, context: Omit<ActCancellation, "request"> & Pick<typeof EffectExecution.Service, "get" | "cancel">) => Effect.Effect<void, Error, CancellationServices> }) => Layer.effect(Implementation, Effect.gen(function* () {
    const services = yield* Effect.context<Exclude<Services, EffectExecution> | CancellationServices>()
    return {
      cancel: (request, execution) => cancellation ? Schema.decodeUnknownEffect(inputSchema)(request.request.input).pipe(
        Effect.mapError(RuntimeError.from),
        Effect.flatMap(input => cancellation.cancel(input, { ...request, ...execution })), Effect.provide(services),
      ) : Effect.void,
      execute: (input, ref) => Effect.suspend(() => {
        const decoded = decodeInput(input)
        return decoded ? Effect.succeed(decoded.value as Input) : Schema.decodeUnknownEffect(inputSchema)(input)
      }).pipe(
        Effect.orDie,
        Effect.flatMap(value => EffectExecution.use(execution => Effect.suspend(() => implement(value, { ref, signal: execution.signal })).pipe(Effect.provideService(EffectExecution, execution), Effect.provide(services)))),
        Effect.flatMap((value): Effect.Effect<ExecutionResult> => typeof value === "object" && value !== null && DeferredType in value
          ? Schema.decodeEffect(ExecutionHandle)(value.handle).pipe(Effect.orDie, Effect.map(handle => ({ type: "promise" as const, handle })))
          : Schema.decodeUnknownEffect(successSchema)(value).pipe(Effect.orDie, Effect.map(value => ({ type: "value" as const, value })))),
        Effect.catch(reason => Schema.decodeEffect(failureSchema)(reason).pipe(Effect.orDie, Effect.flatMap(Effect.fail))),
      ),
    }
  }))

  // request creates an invocation handle retained across reevaluation; another invocation requires another handle.
  const request = (invocation: { readonly origin?: number; readonly input: Input; readonly onRequested?: ActRequest<Value, Failure, ActService<Name>>["onRequested"]; readonly onDeferred?: ActRequest<Value, Failure, ActService<Name>>["onDeferred"]; readonly onSettled?: ActRequest<Value, Failure, ActService<Name>>["onSettled"] }): ActRequest<Value, Failure, ActService<Name>> => {
    const decoded = decodeInput(invocation.input, { freeze: true })
    const input = decoded ? decoded.value as Schema.Json : Schema.decodeUnknownSync(Schema.Json)(structuredClone(Schema.decodeSync(inputSchema)(invocation.input)))
    if (typeof input === "object" && input !== null) actInputs.add(input)
    const origin = invocation.origin === undefined ? undefined : Schema.decodeSync(EffectRef.fields.seq)(invocation.origin)
    const identity = {}
    const ref = atom(get => {
      const context = get(eventLogContext)
      if (!context) return undefined
      const bindings = Context.get(context, EventLog).bindings
      return bindings ? get(bindings).get(identity) : undefined
    })
    const result = atom((get): ActState<Value, Failure | Cancelled | PromiseTimedOut> => {
      const reference = get(ref)
      const context = get(eventLogContext)
      if (!reference || !context) return { status: "pending" }
      const service = Context.get(context, EventLog)
      const events = get(service.events)
      const key = effectKey(reference)
      const cancellation = service.effect?.(reference)?.cancellation ?? events.find(event => Schema.is(EffectCancelled)(event) && effectKey(event.ref) === key)
      if (Schema.is(EffectCancelled)(cancellation)) return { status: "rejected", reason: { _tag: "Cancelled", reason: cancellation.reason } }
      const settlement = service.effect?.(reference)?.settlement ?? events.find(event => Schema.is(EffectSettled)(event) && effectKey(event.ref) === key)
      if (!Schema.is(EffectSettled)(settlement)) return { status: "pending" }
      if (settlement.outcome.status === "rejected") return { status: "rejected", reason: decodeFailure(settlement.outcome.reason) }
      const outcome = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
      if (outcome.type === "value") return { status: "fulfilled", value: decodeSuccess(outcome.value) }
      const resolved = service.promise?.(reference) ?? events.find(event => Schema.is(PromiseSettled)(event) && effectKey(event.ref) === key)
      if (!Schema.is(PromiseSettled)(resolved)) return { status: "pending" }
      return resolved.result.status === "fulfilled"
        ? { status: "fulfilled", value: decodeSuccess(resolved.result.value) }
        : { status: "rejected", reason: Schema.is(PromiseTimedOut)(resolved.result.reason) ? resolved.result.reason : decodeFailure(resolved.result.reason) }
    })
    const handle: ActRequest<Value, Failure, ActService<Name>> = Object.freeze({
      kind: "act", identity, ...(origin === undefined ? {} : { origin }), request: { act: options.name, input }, ref, result,
      ...(invocation.onRequested ? { onRequested: invocation.onRequested } : {}),
      ...(invocation.onDeferred ? { onDeferred: invocation.onDeferred } : {}),
      onSettled: (outcome: Exclude<ActState<Value, Failure | Cancelled | PromiseTimedOut>, { status: "pending" }>, ref: EffectRef, handle?: ExecutionHandle) => {
        const result = outcome.status === "fulfilled"
          ? { status: "fulfilled" as const, value: decodeSuccess(outcome.value) }
          : { status: "rejected" as const, reason: (Schema.is(Cancelled)(outcome.reason) || Schema.is(PromiseTimedOut)(outcome.reason)) ? outcome.reason : decodeFailure(outcome.reason) }
        return invocation.onSettled?.(result, ref, handle) ?? []
      },
      execute: EffectExecution.use(({ ref }) => Implementation.use(service => service.execute(input, ref))),
    })
    return handle
  }

  return {
    name: options.name,
    // pending lists submitted promises awaiting a result for this act definition.
    pending: atom(get => {
      const context = get(eventLogContext)
      if (!context) return []
      const events = get(Context.get(context, EventLog).events)
      return events.filter(Schema.is(EffectAcceptance)).filter(event => event.act === options.name).flatMap(event => {
        const key = effectKey(event.ref)
        if (Context.get(context, EventLog).effect?.(event.ref)?.cancellation || events.some(item => Schema.is(EffectCancelled)(item) && effectKey(item.ref) === key)) return []
        if (events.some(item => Schema.is(PromiseSettled)(item) && effectKey(item.ref) === key)) return []
        const settlement = events.find(item => Schema.is(EffectSettled)(item) && effectKey(item.ref) === key)
        if (!Schema.is(EffectSettled)(settlement) || settlement.outcome.status !== "fulfilled") return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        return result.type === "promise" ? [{ ref: event.ref, handle: result.handle }] : []
      })
    }),
    layer,
    request,
    defer: (handle: ExecutionHandle): DeferredAct => ({ [DeferredType]: true, handle: Schema.decodeSync(ExecutionHandle)(handle) }),
  }
}
