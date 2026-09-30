import { Context, Effect, Layer, Schema } from "effect"
import { atom, type Atom } from "./atom"
import { EventLog, eventLogContext } from "./services/event-log"
import { effectKey, EffectRef } from "./effect-ref"
import { type EffectRequest, EffectRequested, EffectSettled, PromiseSettled } from "./lifecycle"
import { ExecutionHandle } from "./effects"
import { EffectExecution } from "./services/effect-execution"
import { ExecutionResult } from "./execution-result"

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
  readonly id: string
  readonly request: EffectRequest
  readonly kind: "act"
  readonly identity: object
  readonly execute: Effect.Effect<ExecutionResult, Schema.Json, Services | EffectExecution>
  // onRequested derives domain events committed with durable acceptance; callbacks must be pure.
  onRequested?(ref: EffectRef): readonly object[]
  // onSettled derives domain events committed with the immediate or deferred result; callbacks must be pure.
  onSettled?(result: Exclude<ActState<Value, Failure>, { status: "pending" }>, ref: EffectRef): readonly object[]
  readonly ref: Atom<EffectRef | undefined>
  readonly result: Atom<ActState<Value, Failure>>
}

// act defines typed durable work whose implementation is supplied by a layer. Implementations must tolerate redelivery with the same reference after a crash.
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
  // Implementation uses the act name as its service identity across independently constructed definitions.
  // @effect-diagnostics-next-line serviceNotAsClass:off
  const Implementation = Context.Service<ActService<Name>, {
    readonly execute: (input: Schema.Json, ref: EffectRef) => Effect.Effect<ExecutionResult, Schema.Json, EffectExecution>
  }>(`experimental/act/${options.name}`)

  const layer = <Services>(implement: (input: Input, context: { readonly ref: EffectRef }) => Effect.Effect<Value | DeferredAct, Failure, Services>) => Layer.effect(Implementation, Effect.gen(function* () {
    const services = yield* Effect.context<Exclude<Services, EffectExecution>>()
    return {
      execute: (input, ref) => Schema.decodeUnknownEffect(inputSchema)(input).pipe(
        Effect.orDie,
        Effect.flatMap(value => EffectExecution.use(execution => Effect.suspend(() => implement(value, { ref })).pipe(Effect.provideService(EffectExecution, execution), Effect.provide(services)))),
        Effect.flatMap((value): Effect.Effect<ExecutionResult> => typeof value === "object" && value !== null && DeferredType in value
          ? Schema.decodeEffect(ExecutionHandle)(value.handle).pipe(Effect.orDie, Effect.map(handle => ({ type: "promise" as const, handle })))
          : Schema.decodeUnknownEffect(successSchema)(value).pipe(Effect.orDie, Effect.map(value => ({ type: "value" as const, value })))),
        Effect.catch(reason => Schema.decodeEffect(failureSchema)(reason).pipe(Effect.orDie, Effect.flatMap(Effect.fail))),
      ),
    }
  }))

  // request creates an invocation handle retained across reevaluation; another invocation requires another handle.
  const request = (invocation: { readonly tag: string; readonly input: Input; readonly onRequested?: ActRequest<Value, Failure, ActService<Name>>["onRequested"]; readonly onSettled?: ActRequest<Value, Failure, ActService<Name>>["onSettled"] }): ActRequest<Value, Failure, ActService<Name>> => {
    if (!invocation.tag) throw new Error("Act tag must not be empty")
    const input = Schema.decodeUnknownSync(Schema.Json)(structuredClone(Schema.decodeSync(inputSchema)(invocation.input)))
    const identity = {}
    const ref = atom(get => {
      const context = get(eventLogContext)
      if (!context) return undefined
      const bindings = Context.get(context, EventLog).bindings
      return bindings ? get(bindings).get(identity) : undefined
    })
    const result = atom((get): ActState<Value, Failure> => {
      const reference = get(ref)
      const context = get(eventLogContext)
      if (!reference || !context) return { status: "pending" }
      const events = get(Context.get(context, EventLog).events)
      const key = effectKey(reference)
      const settlement = events.find(event => Schema.is(EffectSettled)(event) && effectKey(event.ref) === key)
      if (!Schema.is(EffectSettled)(settlement)) return { status: "pending" }
      if (settlement.outcome.status === "rejected") return { status: "rejected", reason: decodeFailure(settlement.outcome.reason) }
      const outcome = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
      if (outcome.type === "value") return { status: "fulfilled", value: decodeSuccess(outcome.value) }
      const resolved = events.find(event => Schema.is(PromiseSettled)(event) && effectKey(event.ref) === key)
      if (!Schema.is(PromiseSettled)(resolved)) return { status: "pending" }
      return resolved.result.status === "fulfilled"
        ? { status: "fulfilled", value: decodeSuccess(resolved.result.value) }
        : { status: "rejected", reason: decodeFailure(resolved.result.reason) }
    })
    const handle: ActRequest<Value, Failure, ActService<Name>> = Object.freeze({
      kind: "act", identity, id: invocation.tag, request: { executor: options.name, input }, ref, result,
      ...(invocation.onRequested ? { onRequested: invocation.onRequested } : {}),
      onSettled: (outcome: Exclude<ActState<Value, Failure>, { status: "pending" }>, ref: EffectRef) => {
        const result = outcome.status === "fulfilled"
          ? { status: "fulfilled" as const, value: decodeSuccess(outcome.value) }
          : { status: "rejected" as const, reason: decodeFailure(outcome.reason) }
        return invocation.onSettled?.(result, ref) ?? []
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
      return events.filter(Schema.is(EffectRequested)).filter(event => event.request.executor === options.name).flatMap(event => {
        const key = effectKey(event.ref)
        if (events.some(item => Schema.is(PromiseSettled)(item) && effectKey(item.ref) === key)) return []
        const settlement = events.find(item => Schema.is(EffectSettled)(item) && effectKey(item.ref) === key)
        if (!Schema.is(EffectSettled)(settlement) || settlement.outcome.status !== "fulfilled") return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        return result.type === "promise" ? [{ ref: event.ref, input: Schema.decodeUnknownSync(inputSchema)(event.request.input), handle: result.handle }] : []
      })
    }),
    layer,
    request,
    defer: (handle: ExecutionHandle): DeferredAct => ({ [DeferredType]: true, handle: Schema.decodeSync(ExecutionHandle)(handle) }),
  }
}
