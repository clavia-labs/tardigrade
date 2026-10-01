import { type Effect, Schema } from "effect"
import type { EffectExecution } from "../services/effect-execution"
import type { ActRequest } from "./act"
import { type EffectRef, EffectCancelled } from "../runtime/effects"
import type { EffectRequest } from "../runtime/events"
import { atom, type Atom, type Getter } from "./atom"

export { EffectExecution } from "../services/effect-execution"

// EventValue proposes a domain event for direct journal delivery.
export interface EventValue<Event> {
  readonly kind: "event"
  readonly event: Event
}

export interface ActorOutput<View, Event, Services = never> {
  readonly view: View
  readonly events: Readonly<Record<string, EventValue<Event>>>
  readonly acts: Readonly<Record<string, ActRequest<Schema.Json, Schema.Json, Services> | CancelRequest>>
}

export interface CancelRequest {
  readonly kind: "cancel"
  readonly event: EffectCancelled
}

// cancel proposes durable cancellation of an accepted reference (quint/cancellation.qnt, terminalExclusive).
export function cancel(ref: EffectRef, reason: Schema.Json): CancelRequest {
  return { kind: "cancel", event: Schema.decodeSync(EffectCancelled)(structuredClone({ type: "EffectCancelled", ref, reason })) }
}

const AtomValidation = Symbol("AtomValidation")
type ValidatedAtom = Atom<unknown> & { readonly [AtomValidation]?: { readonly input: Schema.Top; readonly validate: (event: object, get: Getter) => void } }

// atomValidator reads the constraint carried through native atom decorators.
export function atomValidator(node: Atom<unknown>): ((event: object, get: Getter) => void) | undefined {
  return (node as ValidatedAtom)[AtomValidation]?.validate
}

// atomInput reads the subscription carried by a constrained effect atom.
export function atomInput(node: Atom<unknown>): Schema.Top | undefined {
  return (node as ValidatedAtom)[AtomValidation]?.input
}

// effectAtom derives a view and typed proposals; input constraints travel with the atom through graph composition.
export function effectAtom<const Value extends ActorOutput<unknown, unknown, unknown>, Event extends object = never>(read: (get: Getter) => Value, options?: {
  readonly input: Schema.Schema<Event>
  readonly validate: (event: NoInfer<Event>, get: Getter) => void
}): Atom<Value> {
  const node = atom(read)
  if (!options) return node
  const accepts = Schema.is(options.input)
  return Object.assign(node, { [AtomValidation]: { input: options.input, validate: (event: object, get: Getter) => {
    if (accepts(event)) options.validate(event, get)
  } } })
}

// eventValue describes a domain event without external work; its producer must withdraw it after delivery.
export function eventValue<Event extends object>(event: Event): EventValue<Event> {
  return { kind: "event", event }
}

export interface EffectWork<Services = never> {
  readonly kind: "act"
  readonly id: string
  readonly request: EffectRequest
  readonly source: string
  readonly ref?: EffectRef
  readonly execute: Effect.Effect<import("../runtime/effects").ExecutionResult, Schema.Json, Services | EffectExecution>
}
export interface IdentifiedEffectValue<Services = never> extends EffectWork<Services> {
  readonly ref: EffectRef
}
type Proposal = EventValue<unknown> | ActRequest<Schema.Json, Schema.Json, unknown> | CancelRequest
type CollectedProposals<Value> = Value extends { readonly events: infer Events; readonly acts: infer Acts } ? Events[keyof Events] | Acts[keyof Acts] : never
export type Proposed<Value> = Extract<NonNullable<CollectedProposals<Value>>, Proposal>
export type ServicesOf<P> = P extends ActRequest<Schema.Json, Schema.Json, infer Services> ? Services | EffectExecution : never
