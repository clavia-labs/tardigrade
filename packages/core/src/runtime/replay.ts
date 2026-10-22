import { LogView, RangeLog, DEFAULT_JOURNAL_READ_BATCH_SIZE, type ReadonlyIndex, type ReadonlyLog } from "./log-view"
import { historicalEventDecoder } from "../event/versioned"
import { frozenPlainData } from "../atoms/incremental/frozen"
import { actInputs } from "../atoms/act"
import { observeRequest, storeRequest, matchesRequest, sameStoredRequest, DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES } from "./input-digest"
import { Context, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import { atom, type Atom } from "../atoms/atom"
import { EventLog, executionDefect, type AtomReplay } from "../services/event-log"
import { createStore } from "../atoms/store"
import { createRecordSource, emptyRecordFrame, observeRecord, type RecordSourceFrame } from "./event-source"
import { journalHistory, memoryHistory, type ReplayHistory } from "./history"
import { recordEvent } from "./record"
import type { ActRequest, ActCancellation } from "../atoms/act"
import { ActorReplayError, ExecutionResult, PromiseTimedOut, EffectCancelled, effectKey, EffectRef, type ExecutionHandle, PromiseNotReady, CancellationOutcome } from "./effects"
import { StoredEffectRequested, EffectAcceptance, EffectRequest, CoreEvent, hasCoreEventType, EffectRequested, EffectSettled, EffectDied, PromiseSettled, RetryScheduled } from "./events"
import { RecordMetadata, type Recorded, type RuntimeEvent, type JournalEvent, type PendingEffectInput } from "../services/journal"
import type { EffectWork, IdentifiedEffectValue, Proposed, ServicesOf } from "../atoms/effect"
import { MessageDelivered, MessageReceived, isMessageReceived } from "../actor/message"
import { ThreadCreated } from "../actor/thread"
import { AtomState, initialStateSeed, StateInitialised, type StatefulAtom, type StateSeed } from "../initialise"
import { collectFamilyKeys, type JournalFamily, type ReadJournalFamily, type ReadJournalFamilyKeys } from "../services/journal/family"


import { operationSettlement, settlementCompletesExecution, cleanupSubmission, cleanupSucceeded, operationComplete, recordedOperation, type StoredOperation } from "./operation"

type Values<Atoms> = { readonly [Key in keyof Atoms]: Atoms[Key] extends Atom<infer Value> ? Value : never }

const reconstructionError = (message: string, position: number) => new ActorReplayError({
  stage: "effect_request", reason: "reconstruction_failed", position, cause: new Error(message),
})

export interface EffectCheckpoint {
  readonly position: number
  readonly durable: readonly { readonly name: string; readonly state: unknown; readonly position: number }[]
}

// createEventLog replays validated domain events and derives identified effect descriptions without executing them.
export function createEventLog<Event extends object, const Atoms extends Readonly<Record<string, Atom<unknown>>>>({ inputs: initialInputs, checkpoint: initialCheckpoint, ...options }: {
  readonly schema: Schema.Schema<Event>
  readonly decodeEvent?: (input: unknown) => Event
  readonly atoms: Atoms
  readonly digestMinBytes?: number
  readonly journalReadBatchSize?: number
  readonly readRange?: (from: number, to: number) => ReadonlyLog<Recorded<Event>>
  readonly checkpoint?: EffectCheckpoint
  readonly readBefore?: (position: number) => ReadonlyLog<Recorded<Event>>
  readonly readOperation?: (ref: EffectRef, position: number) => ReadonlyLog<Recorded<Event>>
  readonly readFamily?: ReadJournalFamily<Event>
  readonly readFamilyKeys?: ReadJournalFamilyKeys
  readonly inputs?: readonly PendingEffectInput[]
}) {
  const digestMinBytes = options.digestMinBytes ?? DEFAULT_EFFECT_INPUT_DIGEST_MIN_BYTES
  if (!Number.isSafeInteger(digestMinBytes) || digestMinBytes < 0) throw new Error("Effect input digest minBytes must be a nonnegative safe integer")
  const batchSize = options.journalReadBatchSize ?? DEFAULT_JOURNAL_READ_BATCH_SIZE
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Journal read batchSize must be a positive safe integer")
  if (options.readRange && !options.readOperation) throw new Error("Journal replay requires operation lookup")
  const restored = initialCheckpoint
  const families = new Map<string, JournalFamily>()
  const indexedFamilies = new Map<JournalFamily, JournalFamily>()
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
  const persistedInputs = new Map((initialInputs ?? []).map(input => [effectKey(input.ref), prepareRequest(input.request)]))
  // acceptedInput hydrates durable payloads before using verified reconstruction for legacy digest-only requests (quint/checkpoint/inputLifecycle.qnt, verifiedExecution).
  const acceptedInput = (record: StoredEffectRequested, proposed: ReturnType<typeof prepareRequest>, concluded: boolean, available = persistedInputs) => {
    const persisted = available.get(effectKey(record.ref))
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
  const recordRange = (journal: ReplayHistory<Event>, position: number, start: number, tailOffset: number, tail: ReadonlyLog<Recorded<Event>>) => new RangeLog<Recorded<Event>>(position - start, (from, to) => {
    const begin = start + from
    const end = start + to
    const prefix = begin < tailOffset ? journal.readRange(begin, Math.min(end, tailOffset)).slice().map((record, index) => recordOf(record, true, begin + index)) : []
    return [...prefix, ...tail.slice(Math.max(0, begin - tailOffset), Math.max(0, end - tailOffset))]
  }, batchSize)
  const indexedFamily = (family: JournalFamily): JournalFamily => {
    const existing = families.get(family.name)
    if (existing && existing !== family) throw new Error(`Duplicate durable atom family name: ${family.name}`)
    families.set(family.name, family)
    let indexed = indexedFamilies.get(family)
    if (!indexed) {
      indexed = { name: family.name, indexVersion: family.indexVersion, key: (record, at) => family.key(recordOf(record as Recorded<Event>, true, at), at) }
      indexedFamilies.set(family, indexed)
    }
    return indexed
  }
  type Snapshot = {
    readonly events: ReadonlyLog<RuntimeEvent<Event>>
    readonly records: ReadonlyLog<Recorded<Event>>
    readonly position: number
    readonly retainedRecords: number
    readonly observations: () => AtomReplay
    readonly progressCursor: number
    readonly seed: EffectCheckpoint | undefined
    readonly inputs: readonly PendingEffectInput[]
    readonly bindings: ReadonlyIndex<object, EffectRef>
    readonly defect: EffectDied | undefined
    readonly get: <Value>(node: Atom<Value>) => Value
    readonly view: () => Values<Atoms>
    readonly effects: () => readonly Work[]
    readonly deferred: () => readonly DeferredWork[]
    readonly cancellations: () => readonly EffectCancelled[]
    readonly cancelled: () => readonly ActCancellation[]
    readonly deliveries: () => readonly Event[]
    readonly pending: () => readonly { readonly type: "EffectRequested"; readonly ref: EffectRef; readonly request: EffectRequest }[]
    readonly effect: (ref: EffectRef) => StoredOperation | undefined
    readonly operations: () => Iterable<StoredOperation>
    readonly retry: (ref: EffectRef, phase?: "execution" | "cancellation") => RetryScheduled | undefined
    readonly promise: (ref: EffectRef) => PromiseSettled | undefined
    readonly checkpoint: () => EffectCheckpoint | undefined
    readonly validate: (roots: Readonly<Record<string, Atom<unknown>>>, event: object) => void
  }
  type Proposal = ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>
  type RuntimeFrame = {
    readonly position: number
    readonly journal: ReplayHistory<Event>
    readonly source: RecordSourceFrame<Event>
    readonly progressCursor: number
    readonly initialState: { readonly seed: StateSeed | undefined } | undefined
    readonly defect: EffectDied | undefined
    readonly operations: ReadonlyMap<string, StoredOperation>
    readonly inputs: ReadonlyMap<string, EffectRequest>
    readonly availableInputs: ReadonlyMap<string, ReturnType<typeof prepareRequest>>
    readonly references: ReadonlyMap<object, EffectRef>
    readonly bindings: ReadonlyIndex<object, EffectRef>
    readonly acts: ReadonlyMap<string, Proposal>
    readonly accepted: ReadonlyMap<string, IdentifiedEffectValue<ServicesOf<EffectValues>>>
    readonly origins: ReadonlyMap<string, EffectRef>
    readonly states: NonNullable<AtomReplay["states"]>
  }
  const actOwners = new WeakMap<object, string>()
  const executionDeclarations = new WeakMap<object, StoredEffectRequested["request"]>()
  const createEngine = (history: ReadonlyLog<Recorded<Event>>, journal: ReplayHistory<Event>, seed?: EffectCheckpoint, frame?: RuntimeFrame) => {
    const inheritedStates = frame?.states
    const availableInputs = new Map(frame?.availableInputs ?? persistedInputs)
    let offset = frame?.position ?? seed?.position ?? 0
    let progressCursor = frame?.progressCursor ?? offset
    const source = createRecordSource<Event>()
    const bindings = atom<ReadonlyIndex<object, EffectRef>>(frame?.bindings ?? new Map())
    // initialState holds the seed once records[0..1], the only records initialStateSeed reads, exist or it found one; an append-only source cannot change it afterwards.
    let initialState: { readonly seed: StateSeed | undefined } | undefined = frame?.initialState
    let defect: EffectDied | undefined = frame?.defect
    // activeOperations retains execution and cleanup until their completion batch is folded (platform/test/properties/runtime/snapshot-lookups.ts).
    const activeOperations = new Map(frame?.operations)
    const storeOperation = (key: string, operation: StoredOperation) => activeOperations.set(key, freeze(operation))
    const loadedInputs = new Map(frame?.inputs)
    const inputOf = (key: string): EffectRequest => {
      const input = loadedInputs.get(key)
      if (!input) throw reconstructionError("Effect requires reconstructed input", offset + records.length)
      return input
    }
    const retire = new Set<string>()
    const requestOf = (key: string) => activeOperations.get(key)?.request
    const settlementOf = (key: string) => operationSettlement(activeOperations.get(key))
    const cancellationOf = (key: string) => activeOperations.get(key)?.cleanup?.request
    const cleanupOutcomeOf = (key: string) => activeOperations.get(key)?.cleanup?.outcome
    const promiseOf = (key: string) => activeOperations.get(key)?.execution.promise
    const hasSettlement = (key: string) => settlementOf(key) !== undefined
    const hasCancellation = (key: string) => cancellationOf(key) !== undefined
    const hasCleanupOutcome = (key: string) => cleanupOutcomeOf(key) !== undefined
    const hasPromise = (key: string) => promiseOf(key) !== undefined
    const activeRequests = () => [...activeOperations].map(([key, operation]) => [key, operation.request] as const)
    const activeSettlements = () => [...activeOperations].flatMap(([key, operation]) => {
      const outcome = operationSettlement(operation)
      return outcome ? [[key, outcome] as const] : []
    })
    const activeCancellations = () => [...activeOperations].flatMap(([key, operation]) => operation.cleanup ? [[key, operation.cleanup.request] as const] : [])
    const updateExecution = (key: string, patch: Partial<StoredOperation["execution"]>) => {
      const operation = activeOperations.get(key)!
      storeOperation(key, { ...operation, execution: { ...operation.execution, ...patch } })
    }
    const updateCleanup = (key: string, patch: Partial<NonNullable<StoredOperation["cleanup"]>>) => {
      const operation = activeOperations.get(key)!
      const request = patch.request ?? operation.cleanup?.request
      if (!request) throw new Error("Cleanup requires cancellation")
      storeOperation(key, { ...operation, cleanup: { ...operation.cleanup, ...patch, request } })
    }
    let recovering = history.length > 0
    const recoveryEnd = offset + history.length
    const stopped = history.some(record => Schema.is(EffectDied)(record.event))
    const isConcluded = (ref: EffectRef) => {
      if (!recovering) return false
      const lifecycle = recordedOperation(journal.readOperation(ref, recoveryEnd), ref)
      return lifecycle !== undefined && (cleanupSucceeded(lifecycle.cleanup?.outcome) || lifecycle.execution.promise !== undefined || settlementCompletesExecution(operationSettlement(lifecycle)) || (stopped && ref.atom !== "host.message.replies" && !lifecycle.cleanup))
    }
    const ranges = (position: number, start = 0) => recordRange(journal, position, start, offset, records)
    const observations = (): AtomReplay => {
      const position = offset + records.length
      const tailOffset = offset
      const tail = records
      return {
        position, seed: stateSeed(), ...(!seed ? { originSeed: { value: stateSeed() } } : {}), ...(inheritedStates ? { states: inheritedStates } : {}),
        readFamily: function* (family, key, from) {
          if (!Number.isSafeInteger(from) || from < 0 || from > position) throw new Error("Atom replay cursor is outside its snapshot")
          const indexed = indexedFamily(family)
          const committedEnd = Math.min(tailOffset, position)
          if (journal.readFamily) {
            for (const entry of journal.readFamily(indexed, key, Math.min(from, committedEnd), committedEnd)) yield { position: entry.position, record: observeRecord(recordOf(entry.record, true, entry.position)) }
          } else if (from < committedEnd) {
            const prefix = recordRange(journal, committedEnd, from, tailOffset, tail)
            let cursor = from
            for (const record of prefix) {
              if (family.key(record, cursor) === key) yield { position: cursor, record: observeRecord(record) }
              cursor++
            }
          }
          for (let cursor = Math.max(from, tailOffset); cursor < position; cursor++) {
            const record = tail.at(cursor - tailOffset)!
            if (family.key(record, cursor) === key) yield { position: cursor, record: observeRecord(record) }
          }
        },
        familyKeys: (family, after, limit) => {
          const indexed = indexedFamily(family)
          const prefix = journal.readFamilyKeys?.(indexed, after, limit, tailOffset)
          const keys = function* () {
            if (prefix) yield* prefix
            else {
              let cursor = 0
              for (const record of recordRange(journal, tailOffset, 0, tailOffset, tail)) yield family.key(record, cursor++)
            }
            for (let cursor = tailOffset; cursor < position; cursor++) yield family.key(tail.at(cursor - tailOffset)!, cursor)
          }
          return collectFamilyKeys(keys(), after, limit)
        },
        read: from => {
          if (!Number.isSafeInteger(from) || from < 0 || from > position) throw new Error("Atom replay cursor is outside its snapshot")
          const history = recordRange(journal, position, from, tailOffset, tail)
          return new RangeLog(history.length, (from, to) => history.slice(from, to).map(observeRecord), batchSize)
        },
      }
    }
    const retry = (ref: EffectRef, phase = "execution") => phase === "execution" ? activeOperations.get(effectKey(ref))?.execution.retry : activeOperations.get(effectKey(ref))?.cleanup?.retry
    const effect = (ref: EffectRef) => activeOperations.get(effectKey(ref))
    const store = createStore(Context.make(EventLog, {
      replay: atom(get => { get(source.records); return observations() }),
      events: atom(get => {
        get(source.records)
        const history = ranges(offset + records.length, seed?.position ?? 0)
        return new RangeLog(history.length, (from, to) => history.slice(from, to).map(record => recordEvent(observeRecord(record))), batchSize)
      }),
      records: atom(get => {
        get(source.records)
        const history = ranges(offset + records.length, seed?.position ?? 0)
        return new RangeLog(history.length, (from, to) => history.slice(from, to).map(observeRecord), batchSize)
      }),
      bindings,
      effect: ref => {
        const state = effect(ref)
        return state ? { ...state, request: Object.freeze(observeRequest(state.request)) } : undefined
      },
      operations: () => [...activeOperations.values()].map(operation => ({ ...operation, request: Object.freeze(observeRequest(operation.request)) })),
      defect: () => defect,
      promise: ref => promiseOf(effectKey(ref)),
    }))
    function stateSeed() {
      if (initialState) return initialState.seed
      const prefix = seed ? [] : ranges(offset + records.length).slice(0, 2)
      const found = initialStateSeed(prefix, seed)
      if (found || seed || offset + records.length >= 2) initialState = { seed: found }
      return found
    }
    const actReferences = new Map(frame?.references)
    let records = store.get(source.records)
    const appendRecords = (batch: readonly Recorded<Event>[]) => {
      records = records.append(batch)
      source.append(store, batch)
    }
    const clearRecords = () => {
      records = LogView.empty
      source.clear(store)
    }
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      disposers.delete(dispose)
      store.dispose()
    }
    disposers.add(dispose)
    const acts = new Map(frame?.acts)
    let deliveries: Event[] = []
    let cancellations: EffectCancelled[] = []
    const proposals = new Map<string, ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>>()
    const accepted = new Map(frame?.accepted)
    // originRefs binds unfinished proposals to accepted references (quint/checkpoint/acceptanceBinding.qnt, recoveryEquivalent).
    const originRefs = new Map(frame?.origins)
    const originKey = (atom: string, act: string, origin: number | undefined) => JSON.stringify([atom, act, origin ?? null])
    const rememberOrigin = (record: StoredEffectRequested) => {
      if (record.ref.act !== record.request.act) throw new Error("Effect reference differs from its act")
      if (record.origin !== undefined && record.origin >= record.ref.seq) throw new Error("Effect origin must precede acceptance")
      const key = originKey(record.ref.atom, record.request.act, record.origin)
      const prior = originRefs.get(key)
      if (prior && effectKey(prior) !== effectKey(record.ref)) throw new Error("Effect origin already has an accepted reference")
      originRefs.set(key, record.ref)
    }
    const bind = (proposal: ActRequest<Schema.Json, Schema.Json, ServicesOf<EffectValues>>, ref: EffectRef) => {
      const prior = acts.get(effectKey(ref))
      if (prior && prior.identity !== proposal.identity && actOwners.get(prior.identity) !== actOwners.get(proposal.identity)) throw new Error("Duplicate effect binding")
      const next = new Map(store.get(bindings))
      for (const [identity, bound] of actReferences) {
        if (effectKey(bound) !== effectKey(ref) || identity === prior?.identity) continue
        actReferences.delete(identity)
        next.delete(identity)
      }
      actReferences.set(proposal.identity, ref)
      acts.set(effectKey(ref), prior ?? proposal)
      next.set(proposal.identity, ref)
      store.set(bindings, next)
    }
    const checkpoint = (): EffectCheckpoint | undefined => {
      // checkpoint captures durable actor state after execution and cleanup settle (platform/test/properties/runtime/snapshot-lookups.ts).
      if (store.get(executionDefect)) return undefined
      if (activeOperations.size !== 0) return undefined
      const captured = new Set<unknown>()
      const durable = [...store.nodes().values()].flatMap(node => {
        const codec = (node.atom as Partial<StatefulAtom>)[AtomState]
        return codec && codec.checkpoint !== false && !captured.has(codec) && captured.add(codec) ? [{ name: codec.name, state: codec.encode(store.get(node.atom)), position: offset + records.length }] : []
      })
      const names = new Set<string>()
      for (const entry of durable) {
        if (names.has(entry.name)) throw new Error(`Duplicate durable atom checkpoint name: ${entry.name}`)
        names.add(entry.name)
      }
      return Object.freeze({
        position: offset + records.length,
        durable: Object.freeze(durable),
      })
    }
    const view = (): Values<Atoms> => Object.fromEntries(Object.entries(options.atoms).map(([name, node]) => [name, store.get(node)])) as Values<Atoms>
    const effects = (): readonly Work[] => {
      const defect = store.get(executionDefect)
      const values = view()
      const owners = new Map<string, string>()
      const roots = new Map<string, string>()
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
          if (!lifecycle) return []
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
          if (!loadedInputs.has(key) && !cleanupSucceeded(cleanupOutcomeOf(key)) && (!settlement || deferred || hasCancellation(key))) loadedInputs.set(key, acceptedInput(recorded, prepared, isConcluded(recorded.ref), availableInputs))
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
      if (!activeOperations.has(key)) throw new Error("Promise settlement requires an accepted effect")
      const settlement = settlementOf(key)
      if (!settlement) throw new PromiseNotReady(event.ref)
      if (settlement.outcome.status !== "fulfilled") throw new Error("Promise settlement requires successful effect settlement")
    }
    const release = (next?: JournalEvent<Event>) => {
      let nextBindings: Map<object, EffectRef> | undefined
      for (const key of retire) {
        if (next && Schema.is(MessageDelivered)(next) && key === effectKey(next.ref)) continue
        const operation = activeOperations.get(key)
        if (!operation || !operationComplete(operation)) { retire.delete(key); continue }
        for (const [identity, ref] of actReferences) {
          if (effectKey(ref) !== key) continue
          actReferences.delete(identity)
          nextBindings ??= new Map(store.get(bindings))
          nextBindings.delete(identity)
        }
        const origin = originKey(operation.ref.atom, operation.request.request.act, operation.request.origin)
        originRefs.delete(origin)
        activeOperations.delete(key)
        loadedInputs.delete(key)
        availableInputs.delete(key)
        acts.delete(key)
        accepted.delete(key)
        retire.delete(key)
      }
      if (nextBindings) store.set(bindings, nextBindings)
    }
    const finish = () => {
      release()
      effects()
    }
    const append = (record: Recorded<Event>) => {
      const event = record.event
      release(event)
      if (Schema.is(ThreadCreated)(event) && offset + records.length !== 0) throw new Error("Thread creation must be the first journal record")
      if (Schema.is(StateInitialised)(event)) {
        if (offset + records.length > 1 || ranges(offset + records.length).some(record => !Schema.is(ThreadCreated)(record.event))) throw new Error("State initialisation requires a fresh journal")
      }
      if (Schema.is(CoreEvent)(event) && event.type !== "ThreadCreated" && event.type !== "ThreadUpdated" && event.type !== "StateInitialised" && event.type !== "MessageDelivered" && !isMessageReceived(event)) {
        const key = effectKey(event.ref)
        if (event.type === "EffectRequested") {
          if (activeOperations.has(key)) {
            const prior = requestOf(key)
            if (!prior || !isDeepStrictEqual(prior.ref, event.ref) || prior.origin !== event.origin || !sameStoredRequest(prior.request, event.request)) throw new Error("Conflicting core effect request")
            appendRecords([record])
            effects()
            return
          }
          if (event.ref.seq !== offset + records.length) throw new Error("Effect reference must match its request position")
          const candidates = effects().filter(work => !work.ref && work.atom === event.ref.atom && work.request.act === event.ref.act && work.origin === event.origin)
          if (candidates.length > 1) throw new Error("Calls to the same act require distinct origins")
          const offered = candidates[0]
          const offeredPrepared = offered ? preparedRequests.get(offered.request) : undefined
          if (!offered) throw reconstructionError("Effect request differs from its proposal", event.ref.seq)
          const input = acceptedInput(event, offeredPrepared ?? prepareRequest(offered.request), isConcluded(event.ref), availableInputs)
          const proposal = proposals.get(offered.source)
          if (!proposal) throw new Error("Effect proposal is missing")
          rememberOrigin(event)
          storeOperation(key, { ref: event.ref, request: event, ...(record.recordedAt === undefined ? {} : { recordedAt: record.recordedAt }), execution: {} })

          loadedInputs.set(key, input)
          bind(proposal, event.ref)
          accepted.set(key, { ...offered, ref: event.ref, request: input })
        } else if (event.type === "EffectDied") {
          if (!activeOperations.has(key)) throw new Error("Defect requires an accepted effect")
          const settlement = settlementOf(key)
          if (hasCancellation(key) || hasPromise(key) || settlementCompletesExecution(settlement)) throw new Error("Defect requires unfinished work")
          defect ??= event
          updateExecution(key, { outcome: event, ...(settlement ? { deferred: settlement } : {}) })

          retire.add(key)
          accepted.delete(key)
        } else if (event.type === "RetryScheduled") {
          if (!activeOperations.has(key)) throw new Error("Retry requires accepted work")
          if (event.phase === "cancellation") {
            if (!hasCancellation(key) || hasCleanupOutcome(key)) throw new Error("Cleanup retry requires unfinished cancellation")
          } else {
            if (hasCancellation(key) || hasPromise(key)) throw new Error("Retry requires pending accepted work")
            const settled = settlementOf(key)
            if (settlementCompletesExecution(settled)) throw new Error("Retry requires pending accepted work")
          }
          const previous = retry(event.ref, event.phase)
          if (event.attempt !== (previous?.attempt ?? 0) + 1) throw new Error("Retry attempt must advance by one")
          if (event.phase === "cancellation") updateCleanup(key, { retry: event })
          else updateExecution(key, { retry: event })
        } else if (event.type === "EffectCancelled") {
          if (!activeOperations.has(key)) throw new Error("Cancellation requires an accepted effect")
          retire.delete(key)
          updateCleanup(key, { request: event })

          accepted.delete(key)
        } else if (Schema.is(CancellationOutcome)(event)) {
          if (!hasCancellation(key)) throw new Error("Cleanup acknowledgement requires cancellation")
          if (hasCleanupOutcome(key)) throw new Error("Duplicate cleanup acknowledgement")
          updateCleanup(key, { outcome: event })

          if (cleanupSucceeded(event)) retire.add(key)
        } else if (event.type === "EffectSettled") {
          if (cleanupSucceeded(cleanupOutcomeOf(key))) throw new Error("Acknowledged cleanup cannot accept a new submission")
          if (!activeOperations.has(key)) throw new Error("Effect must be requested before settlement")
          if (hasSettlement(key)) throw new Error("Duplicate core effect settlement")
          updateExecution(key, { outcome: event })

          if (!hasCancellation(key) && settlementCompletesExecution(event)) retire.add(key)
          accepted.delete(key)
        } else {
          validatePromise(event)
          const prior = promiseOf(key)
          if (prior && !isDeepStrictEqual(prior, event)) throw new Error("Conflicting promise settlement")
          updateExecution(key, { promise: event })

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
      if (Schema.is(EffectSettled)(event) || Schema.is(PromiseSettled)(event) || Schema.is(CancellationOutcome)(event)) progressCursor = offset + records.length + 1
      appendRecords([record])
      effects()
    }
    try {
      effects()
      for (const raw of history) {
        append(recordOf(raw, true, offset + records.length))
        offset += records.length
        clearRecords()
        store.flush()
      }
      recovering = false
      finish()
    } catch (error) {
      dispose()
      throw error
    }
    return {
      frame: (): RuntimeFrame => {
        const states = new Map(inheritedStates)
        for (const node of store.nodes().values()) {
          const codec = (node.atom as Partial<StatefulAtom>)[AtomState]
          if (codec && (codec.idleTTL === undefined || codec.idleTTL === Infinity)) states.set(codec, Object.freeze({ position: offset + records.length, value: store.get(node.atom) }))
        }
        return Object.freeze({
          position: offset + records.length, journal: journal.append(offset, records.slice()), source: source.snapshot(store), progressCursor, initialState,
          defect,
          operations: new Map(activeOperations), inputs: new Map(loadedInputs), availableInputs: new Map(availableInputs),
          references: new Map(actReferences), bindings: store.get(bindings), acts: new Map(acts),
          accepted: new Map(accepted), origins: new Map(originRefs), states,
        })
      },
      release: () => {
        journal = journal.append(offset, records.slice())
        offset += records.length
        clearRecords()
      },
      seed,
      observations,
      get disposed() { return disposed },
      append,
      validatePromise,
      finish,
      dispose,
      cancellations: () => cancellations,
      cancelled: (): readonly ActCancellation[] => activeCancellations().map(([key, cancellation]) => {
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
      get: store.get,
      view,
      effects,
      deferred: (): readonly DeferredWork[] => store.get(executionDefect) ? [] : activeSettlements().flatMap(([key, settlement]) => {
        if (hasCancellation(key) || settlement.outcome.status !== "fulfilled" || hasPromise(key)) return []
        const result = Schema.decodeUnknownSync(ExecutionResult)(settlement.outcome.value)
        if (result.type !== "promise") return []
        const proposal = acts.get(key)
        const request = requestOf(key)
        if (!proposal || !request) throw reconstructionError("Deferred work requires its reconstructed execution", settlement.ref.seq)
        return [{ kind: "act" as const, atom: settlement.ref.atom, source: actOwners.get(proposal.identity)!, ref: settlement.ref,
          request: inputOf(key), execute: proposal.execute, handle: result.handle, deadlineAt: result.deadlineAt }]
      }),
      pending: () => activeRequests().filter(([key]) => !hasSettlement(key) && !hasCancellation(key) && (!defect || requestOf(key)!.ref.atom === "host.message.replies")).map(([key, record]) => ({ type: record.type, ref: record.ref, request: inputOf(key) })),
      effect,
      checkpoint,
      validate: store.validate,
    }
  }
  type Engine = ReturnType<typeof createEngine>
  const engines = new WeakMap<Snapshot, Engine>()
  const frames = new WeakMap<Snapshot, RuntimeFrame>()
  // engineOf restores a registry from captured runtime state without replaying records (platform/test/properties/runtime/snapshot-lookups.ts).
  const engineOf = (snapshot: Snapshot): Engine => {
    const current = engines.get(snapshot)
    if (!frames.has(snapshot)) throw new Error("Snapshot belongs to another event log")
    if (current && !current.disposed) return current
    const restored = createEngine([], frames.get(snapshot)!.journal, snapshot.seed, frames.get(snapshot))
    engines.set(snapshot, restored)
    return restored
  }
  const frameOf = (snapshot: Snapshot): RuntimeFrame => {
    const engine = engines.get(snapshot)
    if (!frames.has(snapshot)) throw new Error("Snapshot belongs to another event log")
    if (engine && !engine.disposed) frames.set(snapshot, engine.frame())
    return frames.get(snapshot)!
  }
  const discard = (snapshot: Snapshot) => {
    frameOf(snapshot)
    engines.get(snapshot)?.dispose()
    engines.delete(snapshot)
  }
  const snapshotOf = (engine: Engine): Snapshot => {
    const work = Object.freeze([...engine.effects()])
    const cancellations = Object.freeze([...engine.cancellations()])
    const deliveries = Object.freeze([...engine.deliveries()])
    const values = Object.freeze(engine.view())
    const pending = Object.freeze(engine.pending())
    const deferred = Object.freeze(engine.deferred())
    const cancelled = Object.freeze(engine.cancelled())
    const frame = engine.frame()
    const operations = frame.operations
    const inputs = frame.inputs
    const snapshot: Snapshot = Object.freeze({
      get events() {
        const records = snapshot.records
        return new RangeLog(records.length, (from, to) => records.slice(from, to).map(record => recordEvent(record)), batchSize)
      },
      get records() {
        const frame = frames.get(snapshot)!
        const start = snapshot.seed?.position ?? 0
        const tailOffset = frame.position - frame.source.records.length
        const tail = frame.source.records
        return recordRange(frame.journal, snapshot.position, start, tailOffset, tail)
      },
      get retainedRecords() { return frames.get(snapshot)!.source.records.length },
      observations: () => ({ ...engineOf(snapshot).observations(), states: frameOf(snapshot).states }),
      position: frame.position,
      progressCursor: frame.progressCursor,
      seed: engine.seed,
      get inputs() {
        return [...inputs].flatMap(([key, request]) => {
          const operation = operations.get(key)
          return operation ? [{ ref: operation.ref, request }] : []
        })
      },
      bindings: frame.bindings,
      defect: frame.defect,
      get: <Value>(node: Atom<Value>): Value => engineOf(snapshot).get(node),
      view: () => values,
      effects: () => work,
      deferred: () => deferred,
      cancellations: () => cancellations,
      cancelled: () => cancelled,
      deliveries: () => deliveries,
      pending: () => pending,
      effect: (ref: EffectRef) => operations.get(effectKey(ref)),
      operations: () => operations.values(),
      retry: (ref: EffectRef, phase?: "execution" | "cancellation") => phase === "cancellation" ? operations.get(effectKey(ref))?.cleanup?.retry : operations.get(effectKey(ref))?.execution.retry,
      promise: (ref: EffectRef) => operations.get(effectKey(ref))?.execution.promise,
      checkpoint: () => engineOf(snapshot).checkpoint(),
      validate: (roots: Readonly<Record<string, Atom<unknown>>>, event: object) => engineOf(snapshot).validate(roots, event),
    })
    frames.set(snapshot, frame)
    engines.set(snapshot, engine)
    return snapshot
  }
  const replay = (history: ReadonlyLog<Recorded<Event>>): Snapshot => {
    const journal = options.readRange ? journalHistory(options.readRange, options.readOperation!, options.readFamily, options.readFamilyKeys) : memoryHistory(history, restored?.position ?? 0, options.readBefore, options.readOperation)
    const engine = createEngine(history, journal, restored)
    try {
      const snapshot = snapshotOf(engine)
      discard(snapshot)
      return snapshot
    } catch (error) {
      engine.dispose()
      throw error
    }
  }
  const append = (snapshot: Snapshot, event: JournalEvent<Event>, metadata: RecordMetadata = {}): Snapshot => {
    const record = eventOf(event, metadata.message?.inReplyTo !== undefined)
    const previous = engineOf(snapshot)
    const defect = snapshot.get(executionDefect)
    if (defect && !(Schema.is(CoreEvent)(record) && "ref" in record && (record.type === "EffectDied" || record.type === "EffectCancelled" || (record.type === "EffectSettled" && cleanupSubmission(previous.effect(record.ref), record)) || Schema.is(CancellationOutcome)(record) || (record.type === "RetryScheduled" && record.phase === "cancellation") || record.ref.atom === "host.message.replies"))) return snapshot
    if (Schema.is(CoreEvent)(record) && record.type !== "ThreadCreated" && record.type !== "ThreadUpdated" && record.type !== "StateInitialised" && record.type !== "MessageDelivered" && !isMessageReceived(record)) {
      const lifecycle = previous.effect(record.ref) ?? (record.ref.seq < snapshot.position ? recordedOperation(frameOf(snapshot).journal.readOperation(record.ref, snapshot.position), record.ref) : undefined)
      if (record.type === "EffectCancelled") {
        if (!lifecycle) throw new Error("Cancellation requires an accepted effect")
        if (lifecycle.cleanup?.request || lifecycle?.execution.promise) return snapshot
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
      const prior = record.type === "RetryScheduled" ? ((record.phase === "cancellation" ? lifecycle?.cleanup?.retry : lifecycle?.execution.retry)?.attempt === record.attempt ? (record.phase === "cancellation" ? lifecycle?.cleanup?.retry : lifecycle?.execution.retry) : undefined) : record.type === "EffectRequested" ? lifecycle?.request
        : record.type === "EffectSettled" ? operationSettlement(lifecycle) : record.type === "EffectCancelled" ? lifecycle?.cleanup?.request : Schema.is(CancellationOutcome)(record) ? lifecycle?.cleanup?.outcome : lifecycle?.execution.promise
      if (prior) {
        if (record.type === "PromiseSettled" && Schema.is(PromiseSettled)(prior) &&
          ((record.result.status === "rejected" && Schema.is(PromiseTimedOut)(record.result.reason)) ||
            (prior.result.status === "rejected" && Schema.is(PromiseTimedOut)(prior.result.reason)))) return snapshot
        const equal = record.type === "EffectRequested" && Schema.is(EffectRequested)(prior)
          ? isDeepStrictEqual(prior.ref, record.ref) && prior.origin === record.origin && sameStoredRequest(prior.request, record.request)
          : isDeepStrictEqual(prior, record)
        if (!equal) throw new Error("Conflicting core event delivery")
        return snapshot
      }
      if (record.type === "PromiseSettled") previous.validatePromise(record)
    }
    const engine = previous
    engines.delete(snapshot)
    try {
      engine.append(recordOf({ event: record, ...metadata }))
      for (const domain of engine.followups(record)) {
        if (hasCoreEventType(domain) && !Schema.is(MessageDelivered)(domain)) throw new Error("Act callbacks must return domain events")
        engine.append(recordOf({ event: eventOf(domain), ...metadata }))
      }
      engine.finish()
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
    append,
    prepare: (previous: Snapshot, event: JournalEvent<Event>, metadata: RecordMetadata = {}) => {
      const next = append(previous, event, metadata)
      return Object.freeze({ previous, next, records: Object.freeze(next.records.slice(previous.records.length)) })
    },
    publish: (prepared: { readonly previous: Snapshot; readonly next: Snapshot }) => {
      const frame = frameOf(prepared.next)
      if (prepared.previous !== prepared.next) discard(prepared.previous)
      frames.set(prepared.next, Object.freeze({ ...frame, source: emptyRecordFrame<Event>() }))
      engines.get(prepared.next)?.release()
      for (const [key] of persistedInputs) if (!frame.operations.has(key)) persistedInputs.delete(key)
      return prepared.next
    },
    // discard releases a registry while retaining its runtime frame (platform/test/properties/runtime/snapshot-lookups.ts).
    discard,
    dispose: () => { for (const dispose of disposers) dispose() },
    get: <Value>(snapshot: Snapshot, node: Atom<Value>): Value => snapshot.get(node),
    view: (snapshot: Snapshot) => snapshot.view(),
    effects: (snapshot: Snapshot) => snapshot.effects(),
    checkpoint: (snapshot: Snapshot): EffectCheckpoint | undefined => snapshot.checkpoint(),
  }
}
