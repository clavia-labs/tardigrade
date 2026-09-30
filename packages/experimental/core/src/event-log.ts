import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "./atom"
import { EventLog } from "./services/event-log"
import { createStore } from "./store"
import { createEventSource } from "./event-source"
import type { ActRequest } from "./act"
import { ExecutionResult } from "./execution-result"
import { EffectRequest, CoreEvent, hasCoreEventType, type EffectRequested, type EffectSettled, type PromiseSettled } from "./lifecycle"
import { effectKey, EffectRef } from "./effect-ref"
import type { Recorded } from "./journal"
import { type EffectWork, type IdentifiedEffectValue, type ExecutionHandle, type Proposed, type ServicesOf } from "./effects"
import { DurableAtomCheckpoint } from "./durable"
import { PromiseNotReady } from "./errors"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

export interface EffectCheckpoint {
  readonly position: number
  readonly durable: readonly { readonly name: string; readonly state: unknown; readonly position: number }[]
  readonly effects: readonly { readonly ref: EffectRef; readonly request: EffectRequested; readonly settlement: EffectSettled }[]
  readonly promises: readonly PromiseSettled[]
}

// createEventLog replays validated domain events and derives identified effect descriptions without executing them.
export function createEventLog<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>>(options: {
  readonly schema: Schema.Schema<Event>
  readonly atoms: Atoms
  readonly checkpoint?: EffectCheckpoint
}) {
  type EffectValues = Proposed<Values<Atoms>[keyof Atoms]>
  type Work = EffectWork<ServicesOf<EffectValues>>
  type DeferredWork = IdentifiedEffectValue<ServicesOf<EffectValues>> & { readonly handle: ExecutionHandle }
  const disposers = new Set<() => void>()
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
  type Snapshot = {
    readonly events: readonly Recorded<Event>[]
    readonly position: number
    readonly seed: EffectCheckpoint | undefined
    readonly bindings: ReadonlyMap<object, EffectRef>
    readonly get: <Value>(node: Atom<Value>) => Value
    readonly view: () => Values<Atoms>
    readonly effects: () => readonly Work[]
    readonly deferred: () => readonly DeferredWork[]
    readonly deliveries: () => readonly Event[]
    readonly followups: (event: Recorded<Event>) => readonly object[]
    readonly pending: () => readonly EffectRequested[]
    readonly effect: (ref: EffectRef) => { readonly request: EffectRequested; readonly settlement?: EffectSettled } | undefined
    readonly promise: (ref: EffectRef) => PromiseSettled | undefined
    readonly checkpoint: () => EffectCheckpoint | undefined
  }
  const createEngine = (history: readonly Recorded<Event>[], seed?: EffectCheckpoint) => {
    const offset = seed?.position ?? 0
    const source = createEventSource<Recorded<Event>>()
    const bindings = atom<ReadonlyMap<object, EffectRef>>(new Map())
    const durable = new Map(seed?.durable.map(entry => [entry.name, entry] as const))
    const coreRequests = new Map<string, EffectRequested>()
    const coreSettlements = new Map<string, EffectSettled>()
    const promiseSettlements = new Map<string, PromiseSettled>()
    const effect = (ref: EffectRef) => {
      const request = coreRequests.get(effectKey(ref))
      if (!request) return undefined
      const settlement = coreSettlements.get(effectKey(ref))
      return settlement ? { request, settlement } : { request }
    }
    const store = createStore(Context.make(EventLog, {
      events: source.events,
      bindings,
      position: seed?.position ?? 0,
      durable,
      effect,
      promise: ref => promiseSettlements.get(effectKey(ref)),
    }))
    const actReferences = new Map<object, EffectRef>()
    const actOwners = new Map<object, string>()
    let records: readonly Recorded<Event>[] = store.get(source.events)
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      disposers.delete(dispose)
      store.dispose()
    }
    disposers.add(dispose)
    const acts = new Map<string, ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>>()
    let deliveries: Event[] = []
    const owners = new Map<string, string>()
    const executionDeclarations = new Map<object, EffectRequest>()
    const proposals = new Map<string, ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>>()
    const accepted = new Map<string, IdentifiedEffectValue<ServicesOf<EffectValues>>>()
    // restoredRefs rebinds handles during the initial checkpoint projection and is cleared before suffix replay.
    const restoredRefs = new Map<string, EffectRef>()
    for (const entry of seed?.effects ?? []) {
      const key = effectKey(entry.ref)
      coreRequests.set(key, entry.request)
      coreSettlements.set(key, entry.settlement)
      restoredRefs.set(`${entry.ref.atom}\u0000${entry.ref.tag}`, entry.ref)
    }
    for (const entry of seed?.promises ?? []) promiseSettlements.set(effectKey(entry.ref), entry)
    const bind = (proposal: ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>, ref: EffectRef) => {
      const prior = acts.get(effectKey(ref))
      if (prior && prior.identity !== proposal.identity) throw new Error("Duplicate effect atom and tag at this sequence")
      actReferences.set(proposal.identity, ref)
      acts.set(effectKey(ref), proposal)
      store.set(bindings, new Map(actReferences))
    }
    const checkpoint = (): EffectCheckpoint | undefined => {
      const pendingEffects = [...coreRequests].filter(([key]) => !coreSettlements.has(key))
      const pendingPromises = [...coreSettlements].some(([key, settlement]) => {
        if (settlement.outcome.status !== "fulfilled") return false
        return Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "promise" && !promiseSettlements.has(key)
      })
      if (pendingEffects.length || pendingPromises) return undefined
      const effects = [...coreRequests].map(([key, request]) => {
        const settlement = coreSettlements.get(key)
        if (!settlement) throw new Error("Effect checkpoint contains an unsettled request")
        return { ref: settlement.ref, request, settlement }
      })
      // TODO: Checkpoint capture must preserve recovery for unread durable atoms absent from the registry; suffix-only restore currently loses their prefix state (quint/checkpoint/lazyAtomCheckpoint.qnt, readyEquivalent, initSkipPrefix).
      const durable = [...store.nodes().values()].flatMap(node => {
        const capture = (node.atom as Partial<Record<typeof DurableAtomCheckpoint, unknown>>)[DurableAtomCheckpoint]
        if (typeof capture !== "function") return []
        return [capture(store.get, offset + records.length) as { readonly name: string; readonly state: unknown; readonly position: number }]
      })
      const names = new Set<string>()
      for (const entry of durable) {
        if (names.has(entry.name)) throw new Error(`Duplicate durable atom checkpoint name: ${entry.name}`)
        names.add(entry.name)
      }
      return Object.freeze({
        position: offset + records.length,
        durable: Object.freeze(durable),
        effects: Object.freeze(effects),
        promises: Object.freeze([...promiseSettlements.values()]),
      })
    }
    const view = (): Values<Atoms> => Object.fromEntries(Object.entries(options.atoms).map(([name, node]) => [name, store.get(node)])) as Values<Atoms>
    const effects = (): readonly Work[] => {
      const values = view()
      proposals.clear()
      deliveries = []
      const identify = (name: string, owner: string, value: unknown): [string, unknown] => {
        const prior = owners.get(name)
        if (prior !== undefined && prior !== owner) throw new Error(`Duplicate effect source: ${name}`)
        owners.set(name, owner)
        return [name, value]
      }
      const candidates = Object.entries(values).flatMap(([name, value]): [string, unknown][] => {
        if (typeof value !== "object" || value === null) return []
        const entries: [string, unknown][] = []
        if (!("view" in value) || (!("events" in value) && !("acts" in value))) return entries
        for (const collection of ["events", "acts"] as const) {
          const proposals = collection === "events" ? ("events" in value ? value.events : undefined) : ("acts" in value ? value.acts : undefined)
          if (typeof proposals !== "object" || proposals === null || Array.isArray(proposals)) throw new Error(`Invalid ${collection} collection from ${name}`)
          for (const [source, proposal] of Object.entries(proposals)) {
            if (!source || source.includes("/")) throw new Error(`Invalid effect source: ${source}`)
            if (typeof proposal !== "object" || proposal === null || !("kind" in proposal) || proposal.kind !== (collection === "events" ? "event" : "act")) throw new Error(`Invalid ${collection} proposal from ${name}/${source}`)
            const path = collection === "acts" ? `${name}/${source}` : `${name}/events/${source}`
            entries.push(identify(path, JSON.stringify([name, collection, source]), proposal))
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
        const ref = assigned ?? restoredRefs.get(`${name}\u0000${proposal.id}`)
        const owner = actOwners.get(proposal.identity)
        if (owner !== undefined && owner !== name) throw new Error("An act request must belong to one source")
        actOwners.set(proposal.identity, name)
        const executionRequest = freeze(Schema.decodeSync(EffectRequest)(proposal.request))
        const previousRequest = executionDeclarations.get(proposal.identity)
        if (previousRequest && !isDeepStrictEqual(previousRequest, executionRequest)) throw new Error("Effect identity reused with a different request")
        executionDeclarations.set(proposal.identity, executionRequest)
        if (ref) {
          const recorded = coreRequests.get(effectKey(ref))
          if (!recorded || !isDeepStrictEqual(recorded.request, executionRequest)) throw new Error("Restored effect request differs from its proposal")
          if (!assigned) bind(proposal, ref)
          return []
        }
        proposals.set(name, proposal)
        return [{ kind: "act" as const, id: proposal.id, source: name, request: executionRequest, execute: proposal.execute }]
      })
      return [...accepted.values(), ...work]
    }
    const validatePromise = (event: PromiseSettled) => {
      const key = effectKey(event.ref)
      if (!coreRequests.has(key)) throw new Error("Promise settlement requires an accepted effect")
      const settlement = coreSettlements.get(key)
      if (!settlement) throw new PromiseNotReady(event.ref)
      if (settlement.outcome.status !== "fulfilled") throw new Error("Promise settlement requires successful effect settlement")
    }
    const append = (event: Recorded<Event>) => {
      if (Schema.is(CoreEvent)(event)) {
        const key = effectKey(event.ref)
        if (event.type === "EffectRequested") {
          if (coreRequests.has(key)) {
            const prior = coreRequests.get(key)
            if (!isDeepStrictEqual(prior, event)) throw new Error("Conflicting core effect request")
            source.append(store, [event])
            records = store.get(source.events)
            effects()
            return
          }
          if (event.ref.seq !== offset + records.length) throw new Error("Effect reference must match its request position")
          const offered = effects().find(work => !work.ref && work.source === event.ref.atom && work.id === event.ref.tag)
          if (!offered || !isDeepStrictEqual(offered.request, event.request)) throw new Error("Effect request differs from its proposal")
          const proposal = proposals.get(event.ref.atom)
          if (!proposal) throw new Error("Effect proposal is missing")
          coreRequests.set(key, event)
          bind(proposal, event.ref)
          accepted.set(key, { ...offered, ref: event.ref, request: event.request })
        } else if (event.type === "EffectSettled") {
          if (!coreRequests.has(key)) throw new Error("Effect must be requested before settlement")
          if (coreSettlements.has(key)) throw new Error("Duplicate core effect settlement")
          coreSettlements.set(key, event)
          accepted.delete(key)
        } else {
          validatePromise(event)
          const prior = promiseSettlements.get(key)
          if (prior && !isDeepStrictEqual(prior, event)) throw new Error("Conflicting promise settlement")
          promiseSettlements.set(key, event)
        }
      }
      source.append(store, [event])
      records = store.get(source.events)
      effects()
    }
    try {
      effects()
      restoredRefs.clear()
      for (const raw of history) append(eventOf(raw))
    } catch (error) {
      dispose()
      throw error
    }
    return {
      seed,
      get events() { return records },
      get position() { return offset + records.length },
      get disposed() { return disposed },
      append,
      validatePromise,
      dispose,
      deliveries: () => deliveries,
      followups: (event: Recorded<Event>): readonly object[] => {
        if (!Schema.is(CoreEvent)(event)) return []
        const request = acts.get(effectKey(event.ref))
        if (!request) return []
        if (event.type === "EffectRequested") return request.onRequested?.(event.ref) ?? []
        if (event.type === "PromiseSettled") {
          const settled = coreSettlements.get(effectKey(event.ref))
          if (!settled || settled.outcome.status !== "fulfilled") return []
          const result = Schema.decodeUnknownSync(ExecutionResult)(settled.outcome.value)
          return result.type === "promise" ? request.onSettled?.(event.result, event.ref, result.handle) ?? [] : []
        }
        if (event.outcome.status === "rejected") return request.onSettled?.(event.outcome, event.ref) ?? []
        const result = Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value)
        return result.type === "value" ? request.onSettled?.({ status: "fulfilled", value: result.value }, event.ref) ?? [] : request.onDeferred?.(result.handle, event.ref) ?? []
      },
      bindings: () => store.get(bindings),
      restoreBindings: (previous: ReadonlyMap<object, EffectRef>) => {
        for (const [identity, ref] of previous) {
          actReferences.set(identity, ref)
          actOwners.set(identity, ref.atom)
        }
        store.set(bindings, new Map(actReferences))
      },
      get: store.get,
      view,
      effects,
      deferred: (): readonly DeferredWork[] => [...coreSettlements].flatMap(([key, settlement]) => {
        if (settlement.outcome.status !== "fulfilled" || promiseSettlements.has(key)) return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        if (result.type !== "promise") return []
        const proposal = acts.get(key)
        const request = coreRequests.get(key)
        if (!proposal || !request) throw new Error("Deferred work requires its reconstructed execution")
        return [{ kind: "act" as const, id: proposal.id, source: settlement.ref.atom, ref: settlement.ref,
          request: request.request, execute: proposal.execute, handle: result.handle }]
      }),
      pending: () => [...coreRequests].filter(([key]) => !coreSettlements.has(key)).map(([, record]) => record),
      effect,
      promise: (ref: EffectRef) => promiseSettlements.get(effectKey(ref)),
      checkpoint,
    }
  }
  type Engine = ReturnType<typeof createEngine>
  const engines = new WeakMap<Snapshot, Engine>()
  // engineOf reconstructs historical or discarded preparation state; current snapshots reuse their registry.
  const engineOf = (snapshot: Snapshot): Engine => {
    const current = engines.get(snapshot)
    if (!current) throw new Error("Snapshot belongs to another event log")
    if (!current.disposed && current.events.length === snapshot.events.length) return current
    const restored = createEngine(snapshot.events, snapshot.seed)
    restored.restoreBindings(snapshot.bindings)
    engines.set(snapshot, restored)
    return restored
  }
  const snapshotOf = (engine: Engine): Snapshot => {
    const work = Object.freeze([...engine.effects()])
    const deliveries = Object.freeze([...engine.deliveries()])
    const values = Object.freeze(engine.view())
    const snapshot: Snapshot = Object.freeze({
      events: engine.events,
      position: engine.position,
      seed: engine.seed,
      bindings: engine.bindings(),
      get: <Value>(node: Atom<Value>): Value => engineOf(snapshot).get(node),
      view: () => values,
      effects: () => work,
      deferred: () => engineOf(snapshot).deferred(),
      deliveries: () => deliveries,
      followups: (event: Recorded<Event>) => engineOf(snapshot).followups(event),
      pending: () => engineOf(snapshot).pending(),
      effect: (ref: EffectRef) => engineOf(snapshot).effect(ref),
      promise: (ref: EffectRef) => engineOf(snapshot).promise(ref),
      checkpoint: () => engineOf(snapshot).checkpoint(),
    })
    engines.set(snapshot, engine)
    return snapshot
  }
  const replay = (history: readonly Recorded<Event>[]): Snapshot => {
    const engine = createEngine(history, options.checkpoint)
    try {
      return snapshotOf(engine)
    } catch (error) {
      engine.dispose()
      throw error
    }
  }
  return {
    get initial() { return replay([]) },
    replay,
    append: (snapshot: Snapshot, event: Recorded<Event>): Snapshot => {
      const record = eventOf(event)
      const engine = engineOf(snapshot)
      if (Schema.is(CoreEvent)(record)) {
        const lifecycle = engine.effect(record.ref)
        const prior = record.type === "EffectRequested" ? lifecycle?.request
          : record.type === "EffectSettled" ? lifecycle?.settlement : engine.promise(record.ref)
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting core event delivery")
          return snapshot
        }
        if (record.type === "PromiseSettled") engine.validatePromise(record)
      }
      try {
        engine.append(record)
        return snapshotOf(engine)
      } catch (error) {
        engine.dispose()
        throw error
      }
    },
    // discard releases a preparation registry; the snapshot's committed history remains available for reconstruction.
    discard: (snapshot: Snapshot) => engines.get(snapshot)?.dispose(),
    dispose: () => { for (const dispose of disposers) dispose() },
    get: <Value>(snapshot: Snapshot, node: Atom<Value>): Value => snapshot.get(node),
    view: (snapshot: Snapshot) => snapshot.view(),
    effects: (snapshot: Snapshot) => snapshot.effects(),
    checkpoint: (snapshot: Snapshot): EffectCheckpoint | undefined => snapshot.checkpoint(),
  }
}
