import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "./atom"
import { EventLog } from "./durable"
import { createStore } from "./store"
import type { ActRequest } from "./act"
import { ExecutionResult } from "./execution-result"
import { EffectRequest, CoreEvent, hasCoreEventType, type EffectRequested, type EffectSettled, type PromiseSettled } from "./lifecycle"
import { effectKey, EffectRef } from "./effect-ref"
import type { Recorded } from "./journal"
import { type IdentifiedEffectValue, type Proposed, type ServicesOf } from "./effects"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

// createEventLog replays validated domain events and derives identified effect descriptions without executing them.
export function createEventLog<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>>(options: {
  readonly schema: Schema.Schema<Event>
  readonly atoms: Atoms
}) {
  type EffectValues = Proposed<Values<Atoms>[keyof Atoms]>
  type Work = IdentifiedEffectValue<ServicesOf<EffectValues>>
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const validateCore = Schema.decodeUnknownSync(Schema.toType(CoreEvent), { onExcessProperty: "error" })
  const freeze = <Value>(value: Value): Value => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Domain events must be plain data")
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  const eventOf = (record: unknown) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) throw new Error("Domain event must be an object")
    if ("effect" in record) throw new Error("Domain effect metadata is not supported")
    return freeze(structuredClone(hasCoreEventType(record) ? validateCore(record) : validate(record)))
  }
  const replay = (history: readonly Recorded<Event>[]) => {
    const source = atom<readonly unknown[]>([])
    const bindings = atom<ReadonlyMap<object, EffectRef>>(new Map())
    const store = createStore(Context.make(EventLog, { events: source, bindings }))
    const actReferences = new Map<object, EffectRef>()
    const actOwners = new Map<object, string>()
    const records: Recorded<Event>[] = []
    const acts = new Map<string, ActRequest<Schema.Json, Schema.Json, unknown>>()
    let deliveries: Event[] = []
    const owners = new Map<string, string>()
    const allocations = new Set<string>()
    const executionDeclarations = new Map<string, EffectRequest>()
    const coreRequests = new Map<string, EffectRequested>()
    const coreSettlements = new Map<string, EffectSettled>()
    const accepted = new Map<string, Work>()
    const promiseSettlements = new Map<string, PromiseSettled>()
    const view = (): Values<Atoms> => Object.fromEntries(Object.entries(options.atoms).map(([name, node]) => [name, store.get(node)])) as Values<Atoms>
    const effects = (): readonly Work[] => {
      const values = view()
      deliveries = []
      const identify = (name: string, owner: string, value: unknown): [string, unknown] => {
        const prior = owners.get(name)
        if (prior !== undefined && prior !== owner) throw new Error(`Duplicate effect source: ${name}`)
        owners.set(name, owner)
        return [name, value]
      }
      const candidates = Object.entries(values).flatMap(([name, value]): [string, unknown][] => {
        if (typeof value !== "object" || value === null) return []
        if ("kind" in value && (value.kind === "event" || value.kind === "act")) return [identify(name, JSON.stringify([name]), value)]
        const entries: [string, unknown][] = []
        if ("effect" in value && value.effect !== undefined) entries.push(identify(name, JSON.stringify([name, "effect"]), value.effect))
        if ("effects" in value && value.effects !== undefined) {
          if (typeof value.effects !== "object" || value.effects === null || Array.isArray(value.effects)) throw new Error(`Invalid effect collection from ${name}`)
          for (const [source, effect] of Object.entries(value.effects)) {
            if (!source || source.includes("/")) throw new Error(`Invalid effect source: ${source}`)
            if (effect !== undefined) entries.push(identify(`${name}/${source}`, JSON.stringify([name, "effects", source]), effect))
          }
        }
        return entries
      })
      const names = new Set<string>()
      const work = candidates.flatMap(([name, candidate]) => {
        if (names.has(name)) throw new Error(`Duplicate effect source: ${name}`)
        names.add(name)
        const native = typeof candidate === "object" && candidate !== null && "kind" in candidate && candidate.kind === "act"
        if (typeof candidate === "object" && candidate !== null && "kind" in candidate && candidate.kind === "event" && "event" in candidate) {
          const event = eventOf(candidate.event)
          if (Schema.is(CoreEvent)(event)) throw new Error("Domain event proposals cannot emit core events")
          deliveries.push(event as Event)
          return []
        }
        if (!native) throw new Error(`Invalid effect value from ${name}`)
        const proposal = candidate as ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>
        if (typeof proposal.id !== "string" || !proposal.id) throw new Error("Effect identity must not be empty")
        const assigned = actReferences.get(proposal.identity)
        const ref = assigned ?? freeze(Schema.decodeSync(EffectRef)({ seq: records.length, atom: name, tag: proposal.id }))
        const owner = actOwners.get(proposal.identity)
        if (owner !== undefined && owner !== name) throw new Error("An act request must belong to one source")
        actOwners.set(proposal.identity, name)
        if (!assigned) {
          if (allocations.has(effectKey(ref))) throw new Error("Duplicate effect atom and tag at this sequence")
          allocations.add(effectKey(ref))
          actReferences.set(proposal.identity, ref)
          acts.set(effectKey(ref), proposal)
          store.set(bindings, new Map(actReferences))
        }
        const executionRequest = freeze(Schema.decodeSync(EffectRequest)(proposal.request))
        const previousRequest = executionDeclarations.get(effectKey(ref))
        if (previousRequest && !isDeepStrictEqual(previousRequest, executionRequest)) throw new Error("Effect identity reused with a different request")
        executionDeclarations.set(effectKey(ref), executionRequest)
        if (coreRequests.has(effectKey(ref))) return []
        return [{ ...proposal, request: executionRequest, ref } as Work]
      })
      return [...accepted.values(), ...work]
    }
    effects()
    for (const raw of history) {
      const record = eventOf(raw)
      const event = record
      if (Schema.is(CoreEvent)(event)) {
        const key = effectKey(event.ref)
        if (event.type === "EffectRequested") {
          if (event.ref.seq > records.length) throw new Error("Effect reference points beyond its request")
          if (coreRequests.has(key)) throw new Error("Duplicate core effect request")
          const offered = effects().find(work => effectKey(work.ref) === key)
          if (!offered || !isDeepStrictEqual(offered.request, event.request)) throw new Error("Effect request differs from its proposal")
          coreRequests.set(key, event)
          accepted.set(key, { ...offered, ref: event.ref, request: event.request })
        } else if (event.type === "EffectSettled") {
          if (!coreRequests.has(key)) throw new Error("Effect must be requested before settlement")
          if (coreSettlements.has(key)) throw new Error("Duplicate core effect settlement")
          coreSettlements.set(key, event)
          accepted.delete(key)
        } else {
          if (!coreRequests.has(key)) throw new Error("Promise settlement requires an accepted effect")
          const prior = promiseSettlements.get(key)
          if (prior && !isDeepStrictEqual(prior, event)) throw new Error("Conflicting promise settlement")
          promiseSettlements.set(key, event)
        }
      }
      records.push(freeze(record))
      store.set(source, Object.freeze([...records]))
      effects()
    }
    return Object.freeze({
      events: Object.freeze(records),
      deliveries: () => { effects(); return deliveries },
      followups: (event: Recorded<Event>): readonly object[] => {
        if (!Schema.is(CoreEvent)(event)) return []
        const request = acts.get(effectKey(event.ref))
        if (!request) return []
        if (event.type === "EffectRequested") return request.onRequested?.(event.ref) ?? []
        if (event.type === "PromiseSettled") {
          const settled = coreSettlements.get(effectKey(event.ref))
          if (!settled || settled.outcome.status !== "fulfilled" || Schema.decodeUnknownSync(ExecutionResult)(settled.outcome.value).type !== "promise") return []
          return request.onSettled?.(event.result, event.ref) ?? []
        }
        if (event.outcome.status === "rejected") return request.onSettled?.(event.outcome, event.ref) ?? []
        const result = Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value)
        return result.type === "value" ? request.onSettled?.({ status: "fulfilled", value: result.value }, event.ref) ?? [] : []
      },
      bindings: new Map(actReferences) as ReadonlyMap<object, EffectRef>,
      get: store.get,
      view,
      effects,
      pending: () => [...coreRequests].filter(([key]) => !coreSettlements.has(key)).map(([, record]) => record),
      effect: (ref: EffectRef) => {
        const request = coreRequests.get(effectKey(ref))
        if (!request) return undefined
        const settlement = coreSettlements.get(effectKey(ref))
        return settlement ? { request, settlement } : { request }
      },
      promise: (ref: EffectRef) => promiseSettlements.get(effectKey(ref)),
    })
  }
  type Snapshot = ReturnType<typeof replay>
  return {
    initial: replay([]),
    replay,
    append: (snapshot: Snapshot, event: Recorded<Event>): Snapshot => {
      const record = eventOf(event)
      if (Schema.is(CoreEvent)(record)) {
        const prior = snapshot.events.find(item => Schema.is(CoreEvent)(item) && item.type === record.type && effectKey(item.ref) === effectKey(record.ref))
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting core event delivery")
          return snapshot
        }
      }
      return replay([...snapshot.events, record])
    },
    get: <Value>(snapshot: Snapshot, node: Atom<Value>): Value => snapshot.get(node),
    view: (snapshot: Snapshot) => snapshot.view(),
    effects: (snapshot: Snapshot) => snapshot.effects(),
  }
}
