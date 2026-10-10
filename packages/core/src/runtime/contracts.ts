import type { ActorMethods } from "../actor/method"
import type { Effect, Schema } from "effect"
import type { Atom } from "../atoms/atom"
import type { RuntimeEvent } from "../services/journal"
import type { Proposed, ServicesOf, EffectExecution } from "../atoms/effect"
import type { EffectRef } from "./effects"
import type { PromisePolicy } from "../services/promises"
import type { ExecutionStream } from "../services/execution-stream"

export type Requirements<Atoms> = Exclude<ServicesOf<Proposed<Atoms[keyof Atoms] extends Atom<infer Value> ? Value : never>>, EffectExecution>

export interface ActorRuntime<Event extends object> {
  readonly execution: typeof ExecutionStream.Service.stream
  readonly promisePolicy: PromisePolicy
  readonly ready: Effect.Effect<void>
  // onReady registers recovery during service construction, after replay and before the store opens.
  readonly onReady: (recover: Effect.Effect<void, Error>) => Effect.Effect<void>
  // onCommit registers runtime work after journal commits; send acknowledgements do not await it.
  readonly onCommit: (work: Effect.Effect<void, Error>) => Effect.Effect<void>
  readonly get: <Value>(node: Atom<Value>) => Value
  readonly sub: <Value>(node: Atom<Value>, listener: () => void) => () => void
  // record acknowledges a journal commit; follow-up work belongs to the runtime.
  readonly record: (event: RuntimeEvent<Event>) => Effect.Effect<void, Error>
  // send acknowledges validated message acceptance; runtime processing failures are reported through the store wait method.
  readonly send: (events: readonly RuntimeEvent<Event>[], when?: (get: ActorRuntime<Event>["get"]) => boolean) => Effect.Effect<void, Error>
  // deliver scopes a result and its domain follow-ups to the originating effect; cancellation suppresses that group.
  readonly deliver: (ref: EffectRef, events: readonly RuntimeEvent<Event>[]) => Effect.Effect<void, Error>
  readonly fork: (id: string, work: Effect.Effect<void, Error>) => Effect.Effect<void, Error>
  readonly interrupt: (id: string) => Effect.Effect<void, Error>
  readonly cancel: (ref: EffectRef, reason: Schema.Json) => Effect.Effect<void, Error>
}

export interface ActorSetup<Event extends object, Atoms extends Readonly<Record<string, Atom<unknown>>>, Contracts extends ActorMethods<Event> = ActorMethods<Event>> {
  readonly schema: Schema.Schema<Event>
  readonly decodeEvent?: (input: unknown) => Event
  readonly contracts: Contracts
  readonly effects: Atoms
}
