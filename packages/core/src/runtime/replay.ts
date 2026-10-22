import { IndexView, type ReadonlyIndex, type ReadonlyLog } from "./log-view"
import { historicalEventDecoder } from "../event/versioned"
import { frozenPlainData } from "../atoms/incremental/frozen"
import { actInputs } from "../atoms/act"
import { observeRequest, storeRequest, matchesRequest, sameStoredRequest, DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES } from "./input-digest"
import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "../atoms/atom"
import { EventLog, executionDefect } from "../services/event-log"
import { createStore } from "../atoms/store"
import { createRecordSource } from "./event-source"
import type { ActRequest, ActCancellation } from "../atoms/act"
import { ActorReplayError, ExecutionResult, PromiseTimedOut, EffectCancelled, effectKey, EffectRef, type ExecutionHandle, PromiseNotReady, CancellationOutcome } from "./effects"
import { StoredEffectRequested, EffectAcceptance, EffectRequest, CoreEvent, hasCoreEventType, EffectRequested, EffectSettled, EffectDied, PromiseSettled, RetryScheduled } from "./events"
import { RecordMetadata, type Recorded, type RuntimeEvent, type JournalEvent, type PendingEffectInput } from "../services/journal"
import type { EffectWork, IdentifiedEffectValue, Proposed, ServicesOf } from "../atoms/effect"
import { MessageDelivered, MessageReceived, isMessageReceived } from "../actor/message"
import { ThreadCreated } from "../actor/thread"
import { AtomState, initialStateSeed, StateInitialised, type StatefulAtom, type StateSeed } from "../initialise"


import { operationSettlement, settlementCompletesExecution, cleanupSubmission, cleanupSucceeded, operationComplete, retireOutcome, sameRetired, type StoredOperation } from "./operation"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

const reconstructionError = (message: string, position: number) => new ActorReplayError({
  stage: "effect_request", reason: "reconstruction_failed", position, cause: new Error(message),
})

export interface EffectCheckpoint {
  readonly position: number
  readonly durable: readonly { readonly name: string; readonly state: unknown; readonly position: number }[]
  readonly operations: readonly StoredOperation[]
}

// retireCheckpoint applies retireOutcome to the checkpoint's complete operations, so a restored log holds digests where the checkpoint held values of at least minBytes.
export function retireCheckpoint(checkpoint: EffectCheckpoint, minBytes: number): EffectCheckpoint {
  const operations = checkpoint.operations.map(operation => operationComplete(operation) ? retireOutcome(operation, minBytes) : operation)
  return operations.every((operation, index) => operation === checkpoint.operations[index]) ? checkpoint : Object.freeze({ ...checkpoint, operations: Object.freeze(operations) })
}

// createEventLog replays validated domain events and derives identified effect descriptions without executing them.
export function createEventLog<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>>(options: {
  readonly schema: Schema.Schema<Event>
  readonly decodeEvent?: (input: unknown) => Event
  readonly atoms: Atoms
  readonly digestMinBytes?: number
  readonly checkpoint?: EffectCheckpoint
  readonly inputs?: readonly PendingEffectInput[]
}) {
  const digestMinBytes = options.digestMinBytes ?? DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES
  if (!Number.isSafeInteger(digestMinBytes) || digestMinBytes < 0) throw new Error("Effect input digest minBytes must be a nonnegative safe integer")
  const restored = options.checkpoint && retireCheckpoint(options.checkpoint, digestMinBytes)
  type EffectValues = Proposed<Values<Atoms>[keyof Atoms]>
  type Work = EffectWork<ServicesOf<EffectValues>>
  type DeferredWork = IdentifiedEffectValue<ServicesOf<EffectValues>> & { readonly handle: ExecutionHandle; readonly deadlineAt: number | undefined }
  const disposers = new Set<() => void>()
  const validate = Schema.decodeUnknownSync(Schema.toType(options.schema), { onExcessProperty: "error" })
  const read = options.decodeEvent ?? historicalEventDecoder(options.schema)
  const validateMetadata = Schema.decodeUnknownSync(RecordMetadata)
  const validateCore = Schema.decodeUnknownSync(Schema.toType(CoreEvent), { onExcessProperty: "error" })
  const frozen = new WeakSet<object>()
  const processedRequests = new WeakSet<object>()
  const preparedRequests = new WeakMap<EffectRequest, { readonly request: EffectRequest; readonly stored: StoredEffectRequested["request"] }>()
  const freeze = <Value>(value: Value): Value => {
    if (typeof value === "object" && value !== null && !frozen.has(value) && !frozenPlainData.has(value)) {
      const prototype = Object.getPrototypeOf(value)
      if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("Domain events must be plain data")
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.get || descriptor.set) throw new Error("Domain events must be plain data")
        freeze(descriptor.value)
      }
      Object.freeze(value)
      frozen.add(value)
    }
    return value
  }
  // prepareRequest retains validated representations after making the source graph immutable (snapshotLookups).
  const prepareRequest = (source: EffectRequest) => {
    const previous = preparedRequests.get(source)
    if (previous) return previous
    freeze(source)
    const trusted = typeof source.input === "object" && source.input !== null && actInputs.has(source.input) && typeof source.act === "string" && source.act.length > 0 && Object.keys(source).length === 2
    const request = trusted ? source : freeze(Schema.decodeSync(EffectRequest)(source))
    const stored = freeze(storeRequest(request, digestMinBytes))
    const prepared = { request, stored }
    preparedRequests.set(source, prepared)
    preparedRequests.set(request, prepared)
    return prepared
  }
  // matchesPrepared is matchesRequest(stored, prepared.request), reusing the digest prepareRequest stored when both sides are digests (storeRequest and digestInput hash the same canonical bytes).
  const matchesPrepared = (stored: StoredEffectRequested["request"], prepared: { readonly request: EffectRequest; readonly stored: StoredEffectRequested["request"] }) =>
    stored.input._tag === "InputDigest" && prepared.stored.input._tag === "InputDigest"
      ? stored.act === prepared.stored.act && isDeepStrictEqual(stored.input, prepared.stored.input)
      : matchesRequest(stored, prepared.request)
  const persistedInputs = new Map((options.inputs ?? []).map(input => [effectKey(input.ref), prepareRequest(input.request)]))
  // acceptedInput hydrates durable payloads before using verified reconstruction for legacy digest-only requests (quint/checkpoint/inputLifecycle.qnt, verifiedExecution).
  const acceptedInput = (record: StoredEffectRequested, proposed: ReturnType<typeof prepareRequest>, concluded: boolean) => {
    const persisted = persistedInputs.get(effectKey(record.ref))
    if (persisted) {
      if (!matchesPrepared(record.request, persisted)) throw new ActorReplayError({ stage: "effect_request", reason: "input_mismatch", position: record.ref.seq, cause: new Error(`Pending input differs from accepted request: ${effectKey(record.ref)}`) })
      return persisted.request
    }
    if (record.request.input._tag === "InlineInput") return prepareRequest({ act: record.request.act, input: record.request.input.value }).request
    if (!concluded && !matchesPrepared(record.request, proposed)) throw new ActorReplayError({ stage: "retained_input", reason: "unavailable", position: record.ref.seq, cause: new Error(`Accepted input is unavailable; effect request differs from its proposal: ${effectKey(record.ref)}`) })
    return proposed.request
  }
  // TODO: drop withoutSelections once no journal holds requests recorded by 0.49.0 to 0.50.0, which stored Grove selections beside a pruned input.
  const withoutSelections = (event: object): object => "type" in event && event.type === "EffectRequested" && "request" in event && typeof event.request === "object" && event.request !== null && "selections" in event.request
    ? { ...event, request: Object.fromEntries(Object.entries(event.request).filter(([key]) => key !== "selections")) }
    : event
  const eventOf = (event: unknown, reply = false, historical = false): JournalEvent<Event> => {
    const decodeDomain = historical ? (input: unknown) => validate(read(input)) : validate
    if (typeof event !== "object" || event === null || Array.isArray(event)) throw new Error("Domain event must be an object")
    if (processedRequests.has(event)) return event as StoredEffectRequested
    if ("effect" in event) throw new Error("Domain effect metadata is not supported")
    if (isMessageReceived(event)) {
      const inbox = Schema.decodeSync(MessageReceived, { onExcessProperty: "error" })(event)
      if (reply) return freeze(structuredClone(inbox))
      if (typeof inbox.body !== "object" || inbox.body === null || hasCoreEventType(inbox.body)) throw new Error("Actor inputs must be domain events")
      return freeze({ type: "MessageReceived", body: structuredClone(decodeDomain(inbox.body)) }) as JournalEvent<Event>
    }
    const result = freeze(structuredClone(hasCoreEventType(event) ? validateCore(historical ? withoutSelections(event) : event) : decodeDomain(event)))
    if ("type" in result && result.type === "EffectRequested") processedRequests.add(result)
    return result
  }
  const recordOf = (record: Recorded<Event>, historical = false, position = 0): Recorded<Event> => {
    try {
      const metadata = validateMetadata(record)
      if (isMessageReceived(record.event) !== (metadata.message !== undefined)) throw new Error("Inbox records require message metadata")
      return freeze({ ...metadata, event: eventOf(record.event, metadata.message?.inReplyTo !== undefined, historical) })
    } catch (cause) {
      throw historical ? ActorReplayError.wrap(cause, { stage: "event", reason: "decode_failed", position }) : cause
    }
  }
  type Snapshot = {
    readonly events: ReadonlyLog<RuntimeEvent<Event>>
    readonly records: ReadonlyLog<Recorded<Event>>
    readonly position: number
    readonly seed: EffectCheckpoint | undefined
    readonly bindings: ReadonlyIndex<object, EffectRef>
    readonly defect: EffectDied | undefined
    readonly get: <Value>(node: Atom<Value>) => Value
    readonly view: () => Values<Atoms>
    readonly effects: () => readonly Work[]
    readonly deferred: () => readonly DeferredWork[]
    readonly cancellations: () => readonly EffectCancelled[]
    readonly cancelled: () => readonly ActCancellation[]
    readonly deliveries: () => readonly Event[]
    readonly followups: (event: JournalEvent<Event>) => readonly object[]
    readonly pending: () => readonly { readonly type: "EffectRequested"; readonly ref: EffectRef; readonly request: EffectRequest }[]
    readonly effect: (ref: EffectRef) => StoredOperation | undefined
    readonly retry: (ref: EffectRef, phase?: "execution" | "cancellation") => RetryScheduled | undefined
    readonly promise: (ref: EffectRef) => PromiseSettled | undefined
    readonly checkpoint: () => EffectCheckpoint | undefined
  }
  const createEngine = (history: ReadonlyLog<Recorded<Event>>, seed?: EffectCheckpoint) => {
    const offset = seed?.position ?? 0
    const source = createRecordSource<Event>()
    const bindings = atom(IndexView.empty<object, EffectRef>())
    // initialState holds the seed once records[0..1], the only records initialStateSeed reads, exist or it found one; an append-only source cannot change it afterwards.
    let initialState: { readonly seed: StateSeed | undefined } | undefined
    const initialisedNames = new Set(seed?.durable.map(entry => entry.name))
    let defect: EffectDied | undefined
    const operations = new Map<string, StoredOperation>()
    // addedAt places checkpoint entries before the suffix and journal entries at their global index (packages/platform/test/properties/runtime/snapshot-lookups.ts).
    const addedAt = new Map<string, number>()
    // retiredRequests preserves the request form visible before retirement (packages/platform/test/properties/runtime/snapshot-lookups.ts).
    const retiredRequests = new Map<string, { readonly position: number; readonly before: StoredEffectRequested }>()
    // retiredOutcomes preserves the execution visible before retireOutcome removed its values (packages/platform/test/properties/runtime/snapshot-lookups.ts).
    const retiredOutcomes = new Map<string, { readonly position: number; readonly before: StoredOperation["execution"] }>()
    const visible = (kind: string, key: string, position: number) => (addedAt.get(`${kind}\0${key}`) ?? Infinity) < position
    const remember = (kind: string, key: string, position: number) => {
      const id = `${kind}\0${key}`
      if (!addedAt.has(id)) addedAt.set(id, position)
    }
    const loadedInputs = new Map<string, EffectRequest>()
    const inputOf = (key: string): EffectRequest => {
      const input = loadedInputs.get(key)
      if (!input) throw reconstructionError("Effect requires reconstructed input", offset + records.length)
      return input
    }
    const retire = new Set<string>()
    const requestOf = (key: string) => operations.get(key)?.request
    const settlementOf = (key: string) => operationSettlement(operations.get(key))
    const cancellationOf = (key: string) => operations.get(key)?.cleanup?.request
    const cleanupOutcomeOf = (key: string) => operations.get(key)?.cleanup?.outcome
    const promiseOf = (key: string) => operations.get(key)?.execution.promise
    const hasSettlement = (key: string) => settlementOf(key) !== undefined
    const hasCancellation = (key: string) => cancellationOf(key) !== undefined
    const hasCleanupOutcome = (key: string) => cleanupOutcomeOf(key) !== undefined
    const hasPromise = (key: string) => promiseOf(key) !== undefined
    const requestEntries = () => [...operations].map(([key, operation]) => [key, operation.request] as const)
    const settlementEntries = () => [...operations].flatMap(([key, operation]) => {
      const outcome = operationSettlement(operation)
      return outcome ? [[key, outcome] as const] : []
    })
    const cancellationEntries = () => [...operations].flatMap(([key, operation]) => operation.cleanup ? [[key, operation.cleanup.request] as const] : [])
    const updateExecution = (key: string, patch: Partial<StoredOperation["execution"]>) => {
      const operation = operations.get(key)!
      operations.set(key, { ...operation, execution: { ...operation.execution, ...patch } })
    }
    const updateCleanup = (key: string, patch: Partial<NonNullable<StoredOperation["cleanup"]>>) => {
      const operation = operations.get(key)!
      const request = patch.request ?? operation.cleanup?.request
      if (!request) throw new Error("Cleanup requires cancellation")
      operations.set(key, { ...operation, cleanup: { ...operation.cleanup, ...patch, request } })
    }
    const concluded = new Set([...[...history].map(record => record.event), ...(seed?.operations.flatMap(entry => entry.execution.outcome ?? []) ?? []), ...(seed?.operations.flatMap(entry => entry.execution.promise ?? []) ?? []), ...(seed?.operations.flatMap(entry => entry.cleanup?.outcome ?? []) ?? [])].flatMap(event =>
      (Schema.is(CancellationOutcome)(event) && cleanupSucceeded(event)) || Schema.is(PromiseSettled)(event) || (Schema.is(EffectSettled)(event) && settlementCompletesExecution(event)) ? [effectKey(event.ref)] : []))
    if ([...history].some(record => Schema.is(EffectDied)(record.event))) {
      const cleanupPending = new Set([...history].flatMap(({ event }) => Schema.is(EffectCancelled)(event) && !concluded.has(effectKey(event.ref)) ? [effectKey(event.ref)] : []))
      for (const { event } of history) if (Schema.is(EffectRequested)(event) && event.ref.atom !== "host.message.replies" && !cleanupPending.has(effectKey(event.ref))) concluded.add(effectKey(event.ref))
    }
    const retries = new Map<string, { readonly position: number; readonly event: RetryScheduled }[]>()
    const retryKey = (ref: EffectRef, phase = "execution") => `${phase}:${effectKey(ref)}`
    const retry = (ref: EffectRef, phase = "execution") => phase === "execution" ? operations.get(effectKey(ref))?.execution.retry : operations.get(effectKey(ref))?.cleanup?.retry
    const retryAt = (ref: EffectRef, position: number, phase = "execution") => {
      const history = retries.get(retryKey(ref, phase)) ?? []
      let low = 0
      let high = history.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (history[middle]!.position < position) low = middle + 1
        else high = middle
      }
      return history[low - 1]?.event
    }
    const effect = (ref: EffectRef) => operations.get(effectKey(ref))
    const effectAt = (ref: EffectRef, position: number): StoredOperation | undefined => {
      const key = effectKey(ref)
      const latest = operations.get(key)
      if (!latest || !visible("request", key, position)) return undefined
      const retiredOutcome = retiredOutcomes.get(key)
      const current = retiredOutcome && position <= retiredOutcome.position ? { ...latest, execution: retiredOutcome.before } : latest
      const retired = retiredRequests.get(key)
      const request = retired && position <= retired.position ? retired.before : current.request
      const settlement = visible("settlement", key, position) ? operationSettlement(current) : undefined
      const outcome = visible("defect", key, position) ? current.execution.outcome : settlement
      const promise = visible("promise", key, position) ? current.execution.promise : undefined
      const executionRetry = retryAt(ref, position)
      const cancellation = visible("cancellation", key, position) ? current.cleanup?.request : undefined
      const cleanupOutcome = visible("cancellationOutcome", key, position) ? current.cleanup?.outcome : undefined
      const cleanupRetry = retryAt(ref, position, "cancellation")
      return { ref, request, execution: {
        ...(outcome ? { outcome } : {}), ...(outcome?.type === "EffectDied" && settlement ? { deferred: settlement } : {}),
        ...(promise ? { promise } : {}), ...(executionRetry ? { retry: executionRetry } : {}), ...(current.execution.retired ? { retired: current.execution.retired } : {}),
      }, ...(cancellation ? { cleanup: { request: cancellation, ...(cleanupOutcome ? { outcome: cleanupOutcome } : {}), ...(cleanupRetry ? { retry: cleanupRetry } : {}) } } : {}) }
    }
    const promiseAt = (ref: EffectRef, position: number) => {
      const key = effectKey(ref)
      const retiredOutcome = retiredOutcomes.get(key)
      return visible("promise", key, position) ? (retiredOutcome && position <= retiredOutcome.position ? retiredOutcome.before.promise : promiseOf(key)) : undefined
    }
    const store = createStore(Context.make(EventLog, {
      events: source.observedEvents,
      records: source.observedRecords,
      bindings,
      position: seed?.position ?? 0,
      initialState: () => {
        if (initialState) return initialState.seed
        const records = store.get(source.records)
        const found = initialStateSeed(records, seed)
        if (found || seed || records.length >= 2) initialState = { seed: found }
        return found
      },
      effect: ref => {
        const state = effect(ref)
        return state ? { ...state, request: Object.freeze(observeRequest(state.request)) } : undefined
      },
      defect: () => defect,
      promise: ref => promiseOf(effectKey(ref)),
    }))
    const actReferences = new Map<object, EffectRef>()
    const actOwners = new Map<object, string>()
    let records: ReadonlyLog<Recorded<Event>> = store.get(source.records)
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
    const roots = new Map<string, string>()
    const executionDeclarations = new WeakMap<object, StoredEffectRequested["request"]>()
    const proposals = new Map<string, ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>>()
    const accepted = new Map<string, IdentifiedEffectValue<ServicesOf<EffectValues>>>()
    // originRefs preserves acceptance bindings through checkpoints and suffix replay (quint/checkpoint/acceptanceBinding.qnt, recoveryEquivalent).
    const originRefs = new Map<string, EffectRef>()
    const originKey = (atom: string, act: string, origin: number | undefined) => JSON.stringify([atom, act, origin ?? null])
    const rememberOrigin = (record: StoredEffectRequested) => {
      if (record.ref.act !== record.request.act) throw new Error("Effect reference differs from its act")
      if (record.origin !== undefined && record.origin >= record.ref.seq) throw new Error("Effect origin must precede acceptance")
      const key = originKey(record.ref.atom, record.request.act, record.origin)
      const prior = originRefs.get(key)
      if (prior && effectKey(prior) !== effectKey(record.ref)) throw new Error("Effect origin already has an accepted reference")
      originRefs.set(key, record.ref)
    }
    for (const entry of seed?.operations ?? []) {
      const key = effectKey(entry.ref)
      rememberOrigin(entry.request)
      operations.set(key, entry)
      remember("request", key, offset - 1)
      if (operationSettlement(entry)) remember("settlement", key, offset - 1)
      if (entry.cleanup) remember("cancellation", key, offset - 1)
      if (entry.cleanup && !cleanupSucceeded(entry.cleanup.outcome) && entry.request.request.input._tag === "InlineInput") loadedInputs.set(key, { act: entry.request.request.act, input: entry.request.request.input.value })
      if (entry.cleanup?.outcome) remember("cancellationOutcome", key, offset - 1)
      if (entry.execution.promise) remember("promise", key, offset - 1)
      for (const event of [entry.execution.retry, entry.cleanup?.retry]) if (event) retries.set(retryKey(entry.ref, event.phase), [{ position: offset - 1, event }])
    }
    const bind = (proposal: ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>, ref: EffectRef) => {
      const prior = acts.get(effectKey(ref))
      if (prior && prior.identity !== proposal.identity) throw new Error("Duplicate effect binding")
      actReferences.set(proposal.identity, ref)
      acts.set(effectKey(ref), proposal)
      store.set(bindings, store.get(bindings).set(proposal.identity, ref))
    }
    const checkpoint = (): EffectCheckpoint | undefined => {
      // checkpoint retains the journal suffix after a defect (quint/checkpoint/effectRecovery.qnt, capture).
      if (store.get(executionDefect)) return undefined
      const pendingEffects = requestEntries().filter(([key]) => !hasSettlement(key) && !hasCancellation(key))
      const pendingPromises = settlementEntries().some(([key, settlement]) => {
        if (hasCancellation(key) || settlement.outcome.status !== "fulfilled") return false
        return Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "promise" && !hasPromise(key)
      })
      if (pendingEffects.length || pendingPromises) return undefined
      const checkpointOperations = [...operations.values()].map(operation => {
        if (!operationSettlement(operation) && !operation.cleanup) throw new Error("Effect checkpoint contains an unsettled request")
        const loaded = operation.cleanup && !cleanupSucceeded(operation.cleanup.outcome) ? inputOf(effectKey(operation.ref)) : undefined
        const request = operation.request
        const stored = loaded ? { act: loaded.act, input: { _tag: "InlineInput" as const, value: loaded.input } } : request.request.input._tag === "InlineInput" ? storeRequest({ act: request.request.act, input: request.request.input.value }, digestMinBytes) : request.request
        return { ...operation, request: { ...request, request: stored } }
      })
      // TODO: Checkpoint capture must preserve recovery for unread durable atoms absent from the registry; suffix-only restore currently loses their prefix state (quint/checkpoint/lazyAtomCheckpoint.qnt, readyEquivalent, initSkipPrefix).
      const captured = new Set<unknown>()
      const durable = [...store.nodes().values()].flatMap(node => {
        const codec = (node.atom as Partial<StatefulAtom>)[AtomState]
        return codec && !captured.has(codec) && captured.add(codec) ? [{ name: codec.name, state: codec.encode(store.get(node.atom)), position: offset + records.length }] : []
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
        operations: Object.freeze(checkpointOperations),
      })
    }
    const view = (): Values<Atoms> => Object.fromEntries(Object.entries(options.atoms).map(([name, node]) => [name, store.get(node)])) as Values<Atoms>
    const effects = (): readonly Work[] => {
      const defect = store.get(executionDefect)
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
      const candidates = Object.entries(values).filter(([name]) => !defect || name === "host.message.replies").flatMap(([name, value]): [string, unknown][] => {
        if (typeof value !== "object" || value === null) return []
        const entries: [string, unknown][] = []
        if (!("view" in value) || (!("events" in value) && !("acts" in value))) return entries
        for (const collection of ["events", "acts"] as const) {
          const proposals = collection === "events" ? ("events" in value ? value.events : undefined) : ("acts" in value ? value.acts : undefined)
          if (typeof proposals !== "object" || proposals === null || Array.isArray(proposals)) throw new Error(`Invalid ${collection} collection from ${name}`)
          for (const [source, proposal] of Object.entries(proposals)) {
            if (!source) throw new Error(`Invalid effect source: ${source}`)
            if (typeof proposal !== "object" || proposal === null || !("kind" in proposal) || (collection === "events" ? proposal.kind !== "event" : proposal.kind !== "act" && proposal.kind !== "cancel")) throw new Error(`Invalid ${collection} proposal from ${name}/${source}`)
            const path = JSON.stringify([name, collection, source])
            roots.set(path, name)
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
          const settlement = operationSettlement(lifecycle)
          const finished = hasPromise(effectKey(event.ref)) || settlementCompletesExecution(settlement)
          if (!lifecycle.cleanup?.request && !finished) cancellations.push(event)
          return []
        }
        if (!native) throw new Error(`Invalid effect value from ${name}`)
        const proposal = candidate as ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>
        const root = roots.get(name)!
        const assigned = actReferences.get(proposal.identity)
        const ref = assigned ?? originRefs.get(originKey(root, proposal.request.act, proposal.origin))
        if (ref && (ref.atom !== root || ref.act !== proposal.request.act)) throw new Error("Accepted reference belongs to a different atom or act")
        const owner = actOwners.get(proposal.identity)
        if (owner !== undefined && owner !== name) throw new Error("An act request must belong to one source")
        actOwners.set(proposal.identity, name)
        const prepared = prepareRequest(proposal.request)
        const executionRequest = prepared.request
        const previousRequest = executionDeclarations.get(proposal.identity)
        if (previousRequest && previousRequest !== prepared.stored && !matchesPrepared(previousRequest, prepared)) throw new Error("Effect identity reused with a different request")
        executionDeclarations.set(proposal.identity, prepared.stored)
        if (ref) {
          const recorded = requestOf(effectKey(ref))
          if (!recorded || recorded.origin !== proposal.origin) throw reconstructionError("Restored effect request differs from its proposal", ref.seq)
          const key = effectKey(ref)
          const settlement = settlementOf(key)
          const deferred = settlement?.outcome.status === "fulfilled" && Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value).type === "promise" && !hasPromise(key)
          if (!cleanupSucceeded(cleanupOutcomeOf(key)) && (!settlement || deferred || hasCancellation(key))) loadedInputs.set(key, acceptedInput(recorded, prepared, concluded.has(key)))
          if (!assigned) bind(proposal, ref)
          return []
        }
        proposals.set(name, proposal)
        return [{ kind: "act" as const, atom: root, ...(proposal.origin === undefined ? {} : { origin: proposal.origin }), source: name, request: executionRequest, execute: proposal.execute }]
      })
      return [...[...accepted.values()].filter(work => !defect || work.atom === "host.message.replies"), ...work]
    }
    const validatePromise = (event: PromiseSettled) => {
      const key = effectKey(event.ref)
      if (!operations.has(key)) throw new Error("Promise settlement requires an accepted effect")
      const settlement = settlementOf(key)
      if (!settlement) throw new PromiseNotReady(event.ref)
      if (settlement.outcome.status !== "fulfilled") throw new Error("Promise settlement requires successful effect settlement")
    }
    const append = (record: Recorded<Event>) => {
      const event = record.event
      for (const key of retire) {
        if (Schema.is(MessageDelivered)(event) && key === effectKey(event.ref)) continue
        const request = requestOf(key)!
        const stored = request.request.input._tag === "InlineInput" ? storeRequest({ act: request.request.act, input: request.request.input.value }, digestMinBytes) : request.request
        if (stored.input._tag !== request.request.input._tag) retiredRequests.set(key, { position: offset + records.length, before: request })
        const operation = operations.get(key)!
        const retiredOperation = retireOutcome({ ...operation, request: { ...request, request: stored } }, digestMinBytes)
        if (retiredOperation.execution !== operation.execution) retiredOutcomes.set(key, { position: offset + records.length, before: operation.execution })
        operations.set(key, retiredOperation)
        loadedInputs.delete(key)
        acts.delete(key)
        retire.delete(key)
      }
      if (Schema.is(ThreadCreated)(event) && offset + records.length !== 0) throw new Error("Thread creation must be the first journal record")
      if (Schema.is(StateInitialised)(event)) {
        if (offset !== 0 || records.length > 1 || records.some(record => !Schema.is(ThreadCreated)(record.event))) throw new Error("State initialisation requires a fresh journal")
        for (const name of Object.keys(event.initialState)) initialisedNames.add(name)
      }
      if (Schema.is(CoreEvent)(event) && event.type !== "ThreadCreated" && event.type !== "ThreadUpdated" && event.type !== "StateInitialised" && event.type !== "MessageDelivered" && !isMessageReceived(event)) {
        const key = effectKey(event.ref)
        if (event.type === "EffectRequested") {
          if (operations.has(key)) {
            const prior = requestOf(key)
            if (!prior || !isDeepStrictEqual(prior.ref, event.ref) || prior.origin !== event.origin || !sameStoredRequest(prior.request, event.request)) throw new Error("Conflicting core effect request")
            source.append(store, [record])
            records = store.get(source.records)
            effects()
            return
          }
          if (event.ref.seq !== offset + records.length) throw new Error("Effect reference must match its request position")
          const candidates = effects().filter(work => !work.ref && work.atom === event.ref.atom && work.request.act === event.ref.act && work.origin === event.origin)
          if (candidates.length > 1) throw new Error("Calls to the same act require distinct origins")
          const offered = candidates[0]
          const offeredPrepared = offered ? preparedRequests.get(offered.request) : undefined
          if (!offered) throw reconstructionError("Effect request differs from its proposal", event.ref.seq)
          const input = acceptedInput(event, offeredPrepared ?? prepareRequest(offered.request), concluded.has(key))
          const proposal = proposals.get(offered.source)
          if (!proposal) throw new Error("Effect proposal is missing")
          rememberOrigin(event)
          operations.set(key, { ref: event.ref, request: event, execution: {} })
          remember("request", key, offset + records.length)
          loadedInputs.set(key, input)
          bind(proposal, event.ref)
          accepted.set(key, { ...offered, ref: event.ref, request: input })
        } else if (event.type === "EffectDied") {
          if (!operations.has(key)) throw new Error("Defect requires an accepted effect")
          const settlement = settlementOf(key)
          if (hasCancellation(key) || hasPromise(key) || settlementCompletesExecution(settlement)) throw new Error("Defect requires unfinished work")
          defect ??= event
          updateExecution(key, { outcome: event, ...(settlement ? { deferred: settlement } : {}) })
          remember("defect", key, offset + records.length)
          accepted.delete(key)
        } else if (event.type === "RetryScheduled") {
          if (!operations.has(key)) throw new Error("Retry requires accepted work")
          if (event.phase === "cancellation") {
            if (!hasCancellation(key) || hasCleanupOutcome(key)) throw new Error("Cleanup retry requires unfinished cancellation")
          } else {
            if (hasCancellation(key) || hasPromise(key)) throw new Error("Retry requires pending accepted work")
            const settled = settlementOf(key)
            if (settlementCompletesExecution(settled)) throw new Error("Retry requires pending accepted work")
          }
          const retryId = retryKey(event.ref, event.phase)
          const history = retries.get(retryId) ?? []
          if (event.attempt !== (history.at(-1)?.event.attempt ?? 0) + 1) throw new Error("Retry attempt must advance by one")
          history.push({ position: offset + records.length, event })
          retries.set(retryId, history)
          if (event.phase === "cancellation") updateCleanup(key, { retry: event })
          else updateExecution(key, { retry: event })
        } else if (event.type === "EffectCancelled") {
          if (!operations.has(key)) throw new Error("Cancellation requires an accepted effect")
          retire.delete(key)
          updateCleanup(key, { request: event })
          remember("cancellation", key, offset + records.length)
          accepted.delete(key)
        } else if (Schema.is(CancellationOutcome)(event)) {
          if (!hasCancellation(key)) throw new Error("Cleanup acknowledgement requires cancellation")
          if (hasCleanupOutcome(key)) throw new Error("Duplicate cleanup acknowledgement")
          updateCleanup(key, { outcome: event })
          remember("cancellationOutcome", key, offset + records.length)
          if (cleanupSucceeded(event)) retire.add(key)
        } else if (event.type === "EffectSettled") {
          if (cleanupSucceeded(cleanupOutcomeOf(key))) throw new Error("Acknowledged cleanup cannot accept a new submission")
          if (!operations.has(key)) throw new Error("Effect must be requested before settlement")
          if (hasSettlement(key)) throw new Error("Duplicate core effect settlement")
          updateExecution(key, { outcome: event })
          remember("settlement", key, offset + records.length)
          if (!hasCancellation(key) && settlementCompletesExecution(event)) retire.add(key)
          accepted.delete(key)
        } else {
          validatePromise(event)
          const prior = promiseOf(key)
          if (prior && !isDeepStrictEqual(prior, event)) throw new Error("Conflicting promise settlement")
          updateExecution(key, { promise: event })
          remember("promise", key, offset + records.length)
          if (!hasCancellation(key)) retire.add(key)
        }
      }
      if (Schema.is(MessageDelivered)(event)) {
        const settlement = settlementOf(effectKey(event.ref))
        const input = loadedInputs.get(effectKey(event.ref))?.input
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
      for (const raw of history) append(recordOf(raw, true, offset + records.length))
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
      get defect() { return defect },
      append,
      validatePromise,
      dispose,
      cancellations: () => cancellations,
      cancelled: (): readonly ActCancellation[] => cancellationEntries().filter(([key]) => !cleanupSucceeded(cleanupOutcomeOf(key))).map(([key, cancellation]) => {
        const settlement = settlementOf(key)
        const result = settlement?.outcome.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value) : undefined
        const request = inputOf(key)
        return { request, ref: cancellation.ref, reason: cancellation.reason,
          ...(result?.type === "promise" ? { handle: result.handle } : {}) }
      }),
      deliveries: () => deliveries,
      followups: (event: JournalEvent<Event>): readonly object[] => {
        if (!Schema.is(CoreEvent)(event) || isMessageReceived(event) || event.type === "ThreadCreated" || event.type === "ThreadUpdated" || event.type === "StateInitialised" || event.type === "MessageDelivered") return []
        const request = acts.get(effectKey(event.ref))
        if (!request) return []
        if (event.type === "EffectCancelled") {
          const settled = settlementOf(effectKey(event.ref))
          const result = settled?.outcome.status === "fulfilled" ? Schema.decodeUnknownSync(ExecutionResult)(settled.outcome.value) : undefined
          return request.onSettled?.({ status: "rejected", reason: { _tag: "Cancelled", reason: event.reason } }, event.ref, result?.type === "promise" ? result.handle : undefined) ?? []
        }
        if (hasCancellation(effectKey(event.ref))) return []
        if (event.type === "RetryScheduled" || event.type === "EffectDied" || Schema.is(CancellationOutcome)(event)) return []
        if (event.type === "EffectRequested") return request.onRequested?.(event.ref) ?? []
        if (event.type === "PromiseSettled") {
          const settled = settlementOf(effectKey(event.ref))
          if (!settled || settled.outcome.status !== "fulfilled") return []
          const result = Schema.decodeUnknownSync(ExecutionResult)(settled.outcome.value)
          return result.type === "promise" ? request.onSettled?.(event.result, event.ref, result.handle) ?? [] : []
        }
        if (event.outcome.status === "rejected") return request.onSettled?.(event.outcome, event.ref) ?? []
        const result = Schema.decodeUnknownSync(ExecutionResult)(event.outcome.value)
        return result.type === "value" ? request.onSettled?.({ status: "fulfilled", value: result.value }, event.ref) ?? [] : request.onDeferred?.(result.handle, event.ref) ?? []
      },
      bindings: () => store.get(bindings),
      restoreBindings: (previous: ReadonlyIndex<object, EffectRef>) => {
        let next = store.get(bindings)
        for (const [identity, ref] of previous) {
          actReferences.set(identity, ref)
          next = next.set(identity, ref)
        }
        store.set(bindings, next)
      },
      get: store.get,
      view,
      effects,
      deferred: (): readonly DeferredWork[] => store.get(executionDefect) ? [] : settlementEntries().flatMap(([key, settlement]) => {
        if (hasCancellation(key) || settlement.outcome.status !== "fulfilled" || hasPromise(key)) return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        if (result.type !== "promise") return []
        const proposal = acts.get(key)
        const request = requestOf(key)
        if (!proposal || !request) throw reconstructionError("Deferred work requires its reconstructed execution", settlement.ref.seq)
        return [{ kind: "act" as const, atom: settlement.ref.atom, source: actOwners.get(proposal.identity)!, ref: settlement.ref,
          request: inputOf(key), execute: proposal.execute, handle: result.handle, deadlineAt: result.deadlineAt }]
      }),
      pending: () => requestEntries().filter(([key]) => !hasSettlement(key) && !hasCancellation(key) && (!defect || requestOf(key)!.ref.atom === "host.message.replies")).map(([key, record]) => ({ type: record.type, ref: record.ref, request: inputOf(key) })),
      effect,
      effectAt,
      retry,
      retryAt,
      promiseAt,
      promise: (ref: EffectRef) => promiseOf(effectKey(ref)),
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
  const extends_ = (engine: Engine, snapshot: Snapshot) => !engine.disposed && engine.seed === snapshot.seed && engine.position >= snapshot.position &&
    (snapshot.records.length === 0 || engine.records.at(snapshot.records.length - 1) === snapshot.records.at(snapshot.records.length - 1))
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
      defect: engine.defect,
      get: <Value>(node: Atom<Value>): Value => engineOf(snapshot).get(node),
      view: () => values,
      effects: () => work,
      deferred: () => engineOf(snapshot).deferred(),
      cancellations: () => cancellations,
      cancelled: () => engineOf(snapshot).cancelled(),
      deliveries: () => deliveries,
      followups: (event: JournalEvent<Event>) => engineOf(snapshot).followups(event),
      pending: () => engineOf(snapshot).pending(),
      effect: (ref: EffectRef) => extends_(engine, snapshot) ? engine.effectAt(ref, snapshot.position) : engineOf(snapshot).effect(ref),
      retry: (ref: EffectRef, phase?: "execution" | "cancellation") => extends_(engine, snapshot) ? engine.retryAt(ref, snapshot.position, phase) : engineOf(snapshot).retry(ref, phase),
      promise: (ref: EffectRef) => extends_(engine, snapshot) ? engine.promiseAt(ref, snapshot.position) : engineOf(snapshot).promise(ref),
      checkpoint: () => engineOf(snapshot).checkpoint(),
    })
    engines.set(snapshot, engine)
    return snapshot
  }
  const replay = (history: ReadonlyLog<Recorded<Event>>): Snapshot => {
    const engine = createEngine(history, restored)
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
    // requestEvent validates acceptance coordinates and reuses this log's immutable request representation (snapshotLookups).
    requestEvent: (ref: EffectRef, request: EffectRequest, origin?: number): StoredEffectRequested => {
      const prepared = prepareRequest(request)
      const acceptance = freeze(Schema.decodeSync(EffectAcceptance, { onExcessProperty: "error" })({ type: "EffectRequested", ref, act: prepared.request.act, ...(origin === undefined ? {} : { origin }) }))
      const event = freeze({ type: acceptance.type, ref: acceptance.ref, ...(acceptance.origin === undefined ? {} : { origin: acceptance.origin }), request: prepared.stored })
      processedRequests.add(event)
      return event
    },
    append: (snapshot: Snapshot, event: JournalEvent<Event>, metadata: RecordMetadata = {}): Snapshot => {
      const record = eventOf(event, metadata.message?.inReplyTo !== undefined)
      const engine = engineOf(snapshot)
      const defect = snapshot.get(executionDefect)
      if (defect && !(Schema.is(CoreEvent)(record) && "ref" in record && (record.type === "EffectDied" || record.type === "EffectCancelled" || (record.type === "EffectSettled" && cleanupSubmission(engine.effect(record.ref), record)) || Schema.is(CancellationOutcome)(record) || (record.type === "RetryScheduled" && record.phase === "cancellation") || record.ref.atom === "host.message.replies"))) return snapshot
      if (Schema.is(CoreEvent)(record) && record.type !== "ThreadCreated" && record.type !== "ThreadUpdated" && record.type !== "StateInitialised" && record.type !== "MessageDelivered" && !isMessageReceived(record)) {
        const lifecycle = engine.effect(record.ref)
        if (record.type === "EffectCancelled") {
          if (!lifecycle) throw new Error("Cancellation requires an accepted effect")
          if (lifecycle.cleanup?.request || engine.promise(record.ref)) return snapshot
          const settlement = operationSettlement(lifecycle)
          if (settlementCompletesExecution(settlement)) return snapshot
        } else if (Schema.is(CancellationOutcome)(record)) {
          if (!lifecycle?.cleanup?.request) throw new Error("Cleanup acknowledgement requires cancellation")
        } else if (lifecycle?.cleanup?.request) {
          if (record.type === "EffectSettled" && cleanupSucceeded(lifecycle.cleanup?.outcome) && !operationSettlement(lifecycle)) throw new Error("Acknowledged cleanup cannot accept a new submission")
          if (record.type === "PromiseSettled" || (record.type === "RetryScheduled" && record.phase !== "cancellation")) return snapshot
          if (record.type === "EffectSettled" && (record.outcome.status !== "fulfilled" || Schema.decodeUnknownSync(ExecutionResult)(record.outcome.value).type !== "promise")) return snapshot
        }
        if (record.type === "EffectDied") {
          const prior = snapshot.get(executionDefect)
          if (prior) {
            if (!isDeepStrictEqual(prior, record)) throw new Error("Conflicting terminal defect")
            return snapshot
          }
        }
        const prior = record.type === "RetryScheduled" ? (engine.retry(record.ref, record.phase)?.attempt === record.attempt ? engine.retry(record.ref, record.phase) : undefined) : record.type === "EffectRequested" ? lifecycle?.request
          : record.type === "EffectSettled" ? operationSettlement(lifecycle) : record.type === "EffectCancelled" ? lifecycle?.cleanup?.request : Schema.is(CancellationOutcome)(record) ? lifecycle?.cleanup?.outcome : engine.promise(record.ref)
        if (prior) {
          if (record.type === "PromiseSettled" && Schema.is(PromiseSettled)(prior) &&
            ((record.result.status === "rejected" && Schema.is(PromiseTimedOut)(record.result.reason)) ||
              (prior.result.status === "rejected" && Schema.is(PromiseTimedOut)(prior.result.reason)))) return snapshot
          const equal = record.type === "EffectRequested" && Schema.is(EffectRequested)(prior)
            ? isDeepStrictEqual(prior.ref, record.ref) && prior.origin === record.origin && sameStoredRequest(prior.request, record.request)
            : isDeepStrictEqual(prior, lifecycle && (record.type === "EffectSettled" || record.type === "PromiseSettled") ? sameRetired(lifecycle, record) : record)
          if (!equal) throw new Error("Conflicting core event delivery")
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
