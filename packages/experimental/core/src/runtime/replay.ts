import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "../atoms/atom"
import { EventLog } from "../services/event-log"
import { createStore } from "../atoms/store"
import { createRecordSource } from "./event-source"
import type { ActRequest, ActCancellation } from "../atoms/act"
import { ExecutionResult, type EffectCancelled, effectKey, EffectRef, type ExecutionHandle, PromiseNotReady } from "./effects"
import { EffectRequest, CoreEvent, hasCoreEventType, type EffectRequested, type EffectSettled, type PromiseSettled } from "./events"
import { RecordMetadata, type Recorded, type RuntimeEvent, type JournalEvent } from "../services/journal"
import type { EffectWork, IdentifiedEffectValue, Proposed, ServicesOf } from "../atoms/effect"
import { DurableAtomCheckpoint } from "../atoms/durable"
import { MessageDelivered, MessageReceived, isMessageReceived } from "../actor/message"
import { ThreadCreated } from "../actor/thread"
import { StateInitialised } from "../initial-state"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

export interface EffectCheckpoint {
  readonly position: number
  readonly durable: readonly { readonly name: string; readonly state: unknown; readonly position: number }[]
  readonly effects: readonly { readonly ref: EffectRef; readonly request: EffectRequested; readonly settlement?: EffectSettled; readonly cancellation?: EffectCancelled }[]
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
  const validateMetadata = Schema.decodeUnknownSync(RecordMetadata)
  const validateCore = Schema.decodeUnknownSync(Schema.toType(CoreEvent), { onExcessProperty: "error" })
  const freeze = <Value>(value: Value): Value => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Domain events must be plain data")
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  const eventOf = (event: unknown, reply = false): JournalEvent<Event> => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) throw new Error("Domain event must be an object")
    if ("effect" in event) throw new Error("Domain effect metadata is not supported")
    if (isMessageReceived(event)) {
      const inbox = Schema.decodeSync(MessageReceived, { onExcessProperty: "error" })(event)
      if (reply) return freeze(structuredClone(inbox))
      if (typeof inbox.body !== "object" || inbox.body === null || hasCoreEventType(inbox.body)) throw new Error("Actor inputs must be domain events")
      return freeze({ type: "MessageReceived", body: structuredClone(validate(inbox.body)) }) as JournalEvent<Event>
    }
    return freeze(structuredClone(hasCoreEventType(event) ? validateCore(event) : validate(event)))
  }
  const recordOf = (record: Recorded<Event>): Recorded<Event> => {
    const metadata = validateMetadata(record)
    if (isMessageReceived(record.event) !== (metadata.message !== undefined)) throw new Error("Inbox records require message metadata")
    return freeze({ ...metadata, event: eventOf(record.event, metadata.message?.inReplyTo !== undefined) })
  }
  type Snapshot = {
    readonly events: readonly RuntimeEvent<Event>[]
    readonly records: readonly Recorded<Event>[]
    readonly position: number
    readonly seed: EffectCheckpoint | undefined
    readonly bindings: ReadonlyMap<object, EffectRef>
    readonly get: <Value>(node: Atom<Value>) => Value
    readonly view: () => Values<Atoms>
    readonly effects: () => readonly Work[]
    readonly deferred: () => readonly DeferredWork[]
    readonly cancellations: () => readonly EffectCancelled[]
    readonly cancelled: () => readonly ActCancellation[]
    readonly deliveries: () => readonly Event[]
    readonly followups: (event: JournalEvent<Event>) => readonly object[]
    readonly pending: () => readonly EffectRequested[]
    readonly effect: (ref: EffectRef) => { readonly request: EffectRequested; readonly settlement?: EffectSettled; readonly cancellation?: EffectCancelled } | undefined
    readonly promise: (ref: EffectRef) => PromiseSettled | undefined
    readonly checkpoint: () => EffectCheckpoint | undefined
  }
  const createEngine = (history: readonly Recorded<Event>[], seed?: EffectCheckpoint) => {
    const offset = seed?.position ?? 0
    const source = createRecordSource<Event>()
    const bindings = atom<ReadonlyMap<object, EffectRef>>(new Map())
    const durable = new Map(seed?.durable.map(entry => [entry.name, entry] as const))
    const initialisedNames = new Set(seed?.durable.map(entry => entry.name))
    const coreRequests = new Map<string, EffectRequested>()
    const coreSettlements = new Map<string, EffectSettled>()
    const coreCancellations = new Map<string, EffectCancelled>()
    const promiseSettlements = new Map<string, PromiseSettled>()
    const effect = (ref: EffectRef) => {
      const request = coreRequests.get(effectKey(ref))
      if (!request) return undefined
      const settlement = coreSettlements.get(effectKey(ref))
      return { request, ...(settlement ? { settlement } : {}), ...(coreCancellations.has(effectKey(ref)) ? { cancellation: coreCancellations.get(effectKey(ref))! } : {}) }
    }
    const store = createStore(Context.make(EventLog, {
      events: source.events,
      records: source.records,
      bindings,
      position: seed?.position ?? 0,
      durable,
      effect,
      promise: ref => promiseSettlements.get(effectKey(ref)),
    }))
    const actReferences = new Map<object, EffectRef>()
    const actOwners = new Map<object, string>()
    let records: readonly Recorded<Event>[] = store.get(source.records)
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
    let cancellations: EffectCancelled[] = []
    const owners = new Map<string, string>()
    const executionDeclarations = new Map<object, EffectRequest>()
    const proposals = new Map<string, ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>>()
    const accepted = new Map<string, IdentifiedEffectValue<ServicesOf<EffectValues>>>()
    // restoredRefs rebinds handles during the initial checkpoint projection and is cleared before suffix replay.
    const restoredRefs = new Map<string, EffectRef>()
    for (const entry of seed?.effects ?? []) {
      const key = effectKey(entry.ref)
      coreRequests.set(key, entry.request)
      if (entry.settlement) coreSettlements.set(key, entry.settlement)
      if (entry.cancellation) coreCancellations.set(key, entry.cancellation)
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
      const pendingEffects = [...coreRequests].filter(([key]) => !coreSettlements.has(key) && !coreCancellations.has(key))
      const pendingPromises = [...coreSettlements].some(([key, settlement]) => {
        if (coreCancellations.has(key) || settlement.outcome.status !== "fulfilled") return false
        return Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "promise" && !promiseSettlements.has(key)
      })
      if (pendingEffects.length || pendingPromises) return undefined
      const effects = [...coreRequests].map(([key, request]) => {
        const settlement = coreSettlements.get(key)
        const cancellation = coreCancellations.get(key)
        if (!settlement && !cancellation) throw new Error("Effect checkpoint contains an unsettled request")
        return { ref: request.ref, request, ...(settlement ? { settlement } : {}), ...(cancellation ? { cancellation } : {}) }
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
      if ([...initialisedNames].some(name => !names.has(name))) return undefined
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
      cancellations = []
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
            if (typeof proposal !== "object" || proposal === null || !("kind" in proposal) || (collection === "events" ? proposal.kind !== "event" : proposal.kind !== "act" && proposal.kind !== "cancel")) throw new Error(`Invalid ${collection} proposal from ${name}/${source}`)
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
        if (typeof candidate === "object" && candidate !== null && "kind" in candidate && candidate.kind === "cancel" && "event" in candidate) {
          const event = validateCore(candidate.event)
          if (event.type !== "EffectCancelled") throw new Error("Invalid cancellation proposal")
          const lifecycle = effect(event.ref)
          if (!lifecycle) throw new Error("Cancellation requires an accepted effect")
          const settlement = lifecycle.settlement
          const finished = promiseSettlements.has(effectKey(event.ref)) || (settlement && (settlement.outcome.status === "rejected" || Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "value"))
          if (!lifecycle.cancellation && !finished) cancellations.push(event)
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
    const append = (record: Recorded<Event>) => {
      const event = record.event
      if (Schema.is(ThreadCreated)(event) && offset + records.length !== 0) throw new Error("Thread creation must be the first journal record")
      if (Schema.is(StateInitialised)(event)) {
        if (offset !== 0 || records.length > 1 || records.some(record => !Schema.is(ThreadCreated)(record.event))) throw new Error("State initialisation requires a fresh journal")
        for (const name of Object.keys(event.initialState)) initialisedNames.add(name)
      }
      if (Schema.is(CoreEvent)(event) && event.type !== "ThreadCreated" && event.type !== "StateInitialised" && event.type !== "MessageDelivered" && !isMessageReceived(event)) {
        const key = effectKey(event.ref)
        if (event.type === "EffectRequested") {
          if (coreRequests.has(key)) {
            const prior = coreRequests.get(key)
            if (!isDeepStrictEqual(prior, event)) throw new Error("Conflicting core effect request")
            source.append(store, [record])
            records = store.get(source.records)
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
        } else if (event.type === "EffectCancelled") {
          if (!coreRequests.has(key)) throw new Error("Cancellation requires an accepted effect")
          coreCancellations.set(key, event)
          accepted.delete(key)
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
      if (Schema.is(MessageDelivered)(event)) {
        const request = coreRequests.get(effectKey(event.ref))
        const settlement = coreSettlements.get(effectKey(event.ref))
        const input = request?.request.input
        if (typeof input !== "object" || input === null || !("inReplyTo" in input) || input.inReplyTo !== event.id || !("id" in input) || input.id !== event.receipt.id || settlement?.outcome.status !== "fulfilled") throw new Error("Delivery completion requires its accepted reply effect")
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        if (result.type !== "value" || !isDeepStrictEqual(result.value, event.receipt)) throw new Error("Delivery receipt differs from effect settlement")
      }
      source.append(store, [record])
      records = store.get(source.records)
      effects()
    }
    try {
      effects()
      restoredRefs.clear()
      for (const raw of history) append(recordOf(raw))
    } catch (error) {
      dispose()
      throw error
    }
    return {
      seed,
      get events() { return store.get(source.events) },
      get records() { return records },
      get position() { return offset + records.length },
      get disposed() { return disposed },
      append,
      validatePromise,
      dispose,
      cancellations: () => cancellations,
      cancelled: (): readonly ActCancellation[] => [...coreCancellations].map(([key, cancellation]) => {
        const settlement = coreSettlements.get(key)
        const result = settlement?.outcome.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value) : undefined
        return { request: coreRequests.get(key)!.request, ref: cancellation.ref, reason: cancellation.reason,
          ...(result?.type === "promise" ? { handle: result.handle } : {}) }
      }),
      deliveries: () => deliveries,
      followups: (event: JournalEvent<Event>): readonly object[] => {
        if (!Schema.is(CoreEvent)(event) || isMessageReceived(event) || event.type === "ThreadCreated" || event.type === "StateInitialised" || event.type === "MessageDelivered") return []
        const request = acts.get(effectKey(event.ref))
        if (!request) return []
        if (event.type === "EffectCancelled") {
          const settled = coreSettlements.get(effectKey(event.ref))
          const result = settled?.outcome.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(settled.outcome.value) : undefined
          return request.onSettled?.({ status: "rejected", reason: { _tag: "Cancelled", reason: event.reason } }, event.ref, result?.type === "promise" ? result.handle : undefined) ?? []
        }
        if (coreCancellations.has(effectKey(event.ref))) return []
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
        if (coreCancellations.has(key) || settlement.outcome.status !== "fulfilled" || promiseSettlements.has(key)) return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        if (result.type !== "promise") return []
        const proposal = acts.get(key)
        const request = coreRequests.get(key)
        if (!proposal || !request) throw new Error("Deferred work requires its reconstructed execution")
        return [{ kind: "act" as const, id: proposal.id, source: settlement.ref.atom, ref: settlement.ref,
          request: request.request, execute: proposal.execute, handle: result.handle }]
      }),
      pending: () => [...coreRequests].filter(([key]) => !coreSettlements.has(key) && !coreCancellations.has(key)).map(([, record]) => record),
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
    const restored = createEngine(snapshot.records, snapshot.seed)
    restored.restoreBindings(snapshot.bindings)
    engines.set(snapshot, restored)
    return restored
  }
  const snapshotOf = (engine: Engine): Snapshot => {
    const work = Object.freeze([...engine.effects()])
    const cancellations = Object.freeze([...engine.cancellations()])
    const deliveries = Object.freeze([...engine.deliveries()])
    const values = Object.freeze(engine.view())
    const snapshot: Snapshot = Object.freeze({
      events: engine.events,
      records: engine.records,
      position: engine.position,
      seed: engine.seed,
      bindings: engine.bindings(),
      get: <Value>(node: Atom<Value>): Value => engineOf(snapshot).get(node),
      view: () => values,
      effects: () => work,
      deferred: () => engineOf(snapshot).deferred(),
      cancellations: () => cancellations,
      cancelled: () => engineOf(snapshot).cancelled(),
      deliveries: () => deliveries,
      followups: (event: JournalEvent<Event>) => engineOf(snapshot).followups(event),
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
    append: (snapshot: Snapshot, event: JournalEvent<Event>, metadata: RecordMetadata = {}): Snapshot => {
      const record = eventOf(event, metadata.message?.inReplyTo !== undefined)
      const engine = engineOf(snapshot)
      if (Schema.is(CoreEvent)(record) && record.type !== "ThreadCreated" && record.type !== "StateInitialised" && record.type !== "MessageDelivered" && !isMessageReceived(record)) {
        const lifecycle = engine.effect(record.ref)
        if (record.type === "EffectCancelled") {
          if (!lifecycle) throw new Error("Cancellation requires an accepted effect")
          if (lifecycle.cancellation || engine.promise(record.ref)) return snapshot
          const settlement = lifecycle.settlement
          if (settlement && (settlement.outcome.status === "rejected" || Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "value")) return snapshot
        } else if (lifecycle?.cancellation) {
          if (record.type === "PromiseSettled") return snapshot
          if (record.type === "EffectSettled" && (record.outcome.status !== "fulfilled" || Schema.decodeUnknownSync(ExecutionResult)(record.outcome.value).type !== "promise")) return snapshot
        }
        const prior = record.type === "EffectRequested" ? lifecycle?.request
          : record.type === "EffectSettled" ? lifecycle?.settlement : record.type === "EffectCancelled" ? lifecycle?.cancellation : engine.promise(record.ref)
        if (prior) {
          if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting core event delivery")
          return snapshot
        }
        if (record.type === "PromiseSettled") engine.validatePromise(record)
      }
      try {
        engine.append(recordOf({ event: record, ...metadata }))
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
