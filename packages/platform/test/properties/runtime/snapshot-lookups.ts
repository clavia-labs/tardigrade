import * as fc from "fast-check"
import { Schema } from "effect"
import { act, createEventLog, durableAtom, effectAtom, effectKey, encodeCheckpoint, decodeCheckpoint, type EffectCheckpoint, type EffectRef, type JournalEvent } from "@clavia/tardigrade-core"
import { isDeepStrictEqual } from "node:util"
import { RangeLog } from "../../../../core/src/runtime/log-view"
import { memoryJournalReads } from "../../fixtures/memory-journal"
import type { Recorded } from "@clavia/tardigrade-core"

const Tick = Schema.Struct({ type: Schema.Literal("Tick"), value: Schema.Finite })
const Finished = Schema.Struct({ type: Schema.Literal("Finished"), atom: Schema.String })
const Event = Schema.Union([Tick, Finished])
const Job = act({ name: "test.snapshot", input: Schema.Json, success: Schema.Json, failure: Schema.String })
const mode = fc.constantFrom("pending", "value", "failure", "deferred", "promise", "cancel", "cancelPromise")

// snapshotLookups checks prefix isolation, retirement, branches, disposal, and checkpoint recovery against independent replay; unfinished work matches journal facts (core/quint/checkpoint/acceptanceBinding.qnt, activeOnly, admissionSound).
export const snapshotLookups = fc.property(fc.jsonValue(), fc.array(mode, { minLength: 2, maxLength: 8 }), fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 8, maxLength: 8 }), fc.boolean(), fc.array(fc.nat(), { maxLength: 40 }), (value, modes, padding, reverse, order) => {
  const input = Schema.decodeUnknownSync(Schema.Json)(value)
  callbackFrame(input, padding)
  journalFrame(input, padding)
  const names = modes.map((_, index) => `job${index}`)
  const indices = [...modes.keys()]
  if (reverse) indices.reverse()
  let evaluations = 0
  let reductions = 0
  const open = (checkpoint?: EffectCheckpoint) => createEventLog({ schema: Event, ...(checkpoint ? { checkpoint } : {}), digestMinBytes: reverse ? 0 : Number.MAX_SAFE_INTEGER,
    atoms: Object.fromEntries([...names, "suffix"].map(name => {
      const request = Job.request({ input, onSettled: () => [{ type: "Finished", atom: name }] })
      const done = durableAtom({ name: `${name}.done`, input: Finished, schema: Schema.Boolean, initial: false, reduce: (state, event) => { reductions++; return state || event.atom === name } })
      if (typeof request.request.input === "object" && request.request.input !== null) Object.freeze(request.request.input)
      return [name, effectAtom(get => { evaluations++; return { view: { done: get(done) }, events: {}, acts: get(done) ? {} : { job: request } } })]
    })),
  })
  const log = open()
  type Snapshot = ReturnType<typeof log.replay>
  const refs: EffectRef[] = []
  const snapshots: Snapshot[] = [log.initial]
  let current = snapshots[0]!
  const append = (event: JournalEvent<typeof Event.Type>) => { current = log.append(current, event, { recordedAt: 100 + current.position }); snapshots.push(current) }
  let step = 0
  const pad = () => { for (let i = 0; i < padding[step++ % padding.length]!; i++) append({ type: "Tick", value: step }) }
  const answers = (snapshot: Snapshot) => refs.map(ref => ({ effect: snapshot.effect(ref), promise: snapshot.promise(ref), retry: snapshot.retry(ref) }))
  const expected = new WeakMap<Snapshot, ReturnType<typeof answers>>()
  const oracles = new Map<EffectCheckpoint | undefined, ReturnType<typeof open>>()
  const requestsFor = (snapshot: Snapshot) => [...snapshot.records].map(record => record.event).filter(event => event.type === "EffectRequested")
  const check = (snapshot: Snapshot) => {
    let lookup = expected.get(snapshot)
    if (!lookup) {
      let oracle = oracles.get(snapshot.seed)
      if (!oracle) { oracle = open(snapshot.seed); oracles.set(snapshot.seed, oracle) }
      const independent = oracle.replay(snapshot.records)
      try { lookup = answers(independent) }
      finally { oracle.discard(independent) }
      expected.set(snapshot, lookup)
    }
    if (!isDeepStrictEqual(answers(snapshot), lookup)) throw new Error(`Snapshot lookup differs from replay at ${snapshot.position}`)
    const events = [...snapshot.records].map(record => record.event)
    let progressCursor = snapshot.seed?.position ?? 0
    for (const [index, event] of events.entries()) if (event.type === "EffectSettled" || event.type === "PromiseSettled" || event.type === "CancellationSettled" || event.type === "CancellationDied") progressCursor = (snapshot.seed?.position ?? 0) + index + 1
    if (snapshot.progressCursor !== progressCursor) throw new Error(`Recovery progress differs from journal facts at ${snapshot.position}`)
    const work = { pending: [] as string[], deferred: [] as string[], cleanup: [] as string[] }
    for (const request of events.filter(event => event.type === "EffectRequested")) {
      const key = effectKey(request.ref)
      const history = events.filter(event => "ref" in event && effectKey(event.ref) === key)
      const settlement = history.find(event => event.type === "EffectSettled")
      if (history.some(event => event.type === "EffectCancelled")) {
        if (!history.some(event => event.type === "CancellationSettled" && event.outcome.status === "fulfilled")) work.cleanup.push(key)
      } else if (!settlement) work.pending.push(key)
      else if (settlement.outcome.status === "fulfilled" && !history.some(event => event.type === "PromiseSettled")) {
        const value = settlement.outcome.value
        if (typeof value === "object" && value !== null && "type" in value && value.type === "promise") work.deferred.push(key)
      }
    }
    const actual = {
      pending: snapshot.pending().map(work => effectKey(work.ref)),
      deferred: snapshot.deferred().map(work => effectKey(work.ref)),
      cleanup: snapshot.cancelled().map(work => effectKey(work.ref)),
    }
    const unaccepted = Object.entries(snapshot.view()).filter(([name, actor]) => !actor.view.done && !requestsFor(snapshot).some(request => request.ref.atom === name)).map(([name]) => name)
    if (!isDeepStrictEqual(snapshot.effects().filter(work => !work.ref).map(work => work.atom), unaccepted)) throw new Error(`Completed work was proposed again at ${snapshot.position}`)
    if (!isDeepStrictEqual(actual, work)) throw new Error(`Unfinished work differs from journal facts at ${snapshot.position}`)
    if (!isDeepStrictEqual(snapshot.get(Job.pending).map(work => effectKey(work.ref)), work.deferred)) throw new Error(`Act pending differs from active promises at ${snapshot.position}`)
    const retained = requestsFor(snapshot).filter(request => snapshot.effect(request.ref)).map(request => effectKey(request.ref)).sort()
    if (!isDeepStrictEqual(retained, [...work.pending, ...work.deferred, ...work.cleanup].sort())) throw new Error(`Retained operations differ from unfinished work at ${snapshot.position}`)
    for (const request of requestsFor(snapshot)) {
      const operation = snapshot.effect(request.ref)
      if (operation && operation.recordedAt !== snapshot.records.at(request.ref.seq - (snapshot.seed?.position ?? 0))?.recordedAt) throw new Error(`Accepted time differs from journal facts at ${snapshot.position}`)
      immutable(operation)
    }
    if (!isDeepStrictEqual(snapshot.effects().flatMap(work => work.ref ? [effectKey(work.ref)] : []), work.pending)) throw new Error(`Executable work differs from pending requests at ${snapshot.position}`)
    const checkpoint = snapshot.checkpoint()
    if ((checkpoint !== undefined) !== (work.pending.length === 0 && work.deferred.length === 0 && work.cleanup.length === 0)) throw new Error(`Checkpoint eligibility differs from unfinished work at ${snapshot.position}`)
    if (checkpoint && !isDeepStrictEqual(Object.keys(checkpoint).sort(), ["durable", "position"])) throw new Error(`Checkpoint contains operation state at ${snapshot.position}`)
  }
  try {
    for (const index of indices) {
      pad()
      const ref = { seq: current.position, atom: names[index]!, act: Job.name }
      refs.push(ref)
      const offered = current.effects().find(work => !work.ref && work.atom === ref.atom)!
      const request = log.requestEvent(ref, offered.request, offered.origin)
      if (current.effects().find(work => !work.ref && work.atom === ref.atom)!.request !== offered.request || log.requestEvent(ref, offered.request, offered.origin).request !== request.request) throw new Error("Live request preparation repeated its payload work")
      immutable(offered.request)
      immutable(request)
      for (const malformed of [{ ...request, extra: true }, { ...request, origin: -1 }, { ...request, ref: { ...ref, act: "wrong" } }, { ...request, request: { act: Job.name, input: null } }]) {
        rejects(() => log.append(current, malformed as typeof request))
      }
      rejects(() => log.requestEvent({ ...ref, act: "wrong" }, offered.request))
      rejects(() => log.requestEvent(ref, { act: Job.name, input: Object.freeze({ get value() { return input } }) }))
      append(request)
      if (current.records.at(-1)!.event !== request) throw new Error("Live request acceptance copied its processed event")
      pad()
      for (let attempt = 1; attempt <= padding[index]!; attempt++) {
        const retry = { type: "RetryScheduled" as const, ref, attempt, dueAt: attempt * 100, reason: input }
        append(retry)
        if (log.append(current, retry) !== current) throw new Error("Duplicate retry changed the snapshot")
        rejects(() => log.append(current, { ...retry, dueAt: -1 }))
        rejects(() => log.replay([...current.records, { event: { ...retry, attempt: attempt + 2 } }]))
      }
    }
    const queues = indices.map(index => {
      const ref = refs.find(ref => ref.atom === names[index])!
      const selected = modes[index]!
      const events: JournalEvent<typeof Event.Type>[] = []
      if (selected === "pending") return events
      if (selected === "cancel") events.push({ type: "EffectCancelled", ref, reason: input })
      else {
        events.push({ type: "EffectSettled", ref, outcome: selected === "failure" ? { status: "rejected", reason: "failed" } : { status: "fulfilled", value: selected === "value" ? { type: "value", value: input } : { type: "promise", handle: { executor: "test", id: ref.atom } } } })
        for (let i = 0; i < padding[step++ % padding.length]!; i++) events.push({ type: "Tick", value: step })
        if (selected === "cancelPromise") events.push({ type: "EffectCancelled", ref, reason: input })
        if (selected === "promise" || selected === "cancelPromise") events.push({ type: "PromiseSettled", ref, result: { status: "fulfilled", value: input } })
      }
      if (selected === "cancel" || selected === "cancelPromise") {
        for (let attempt = 1; attempt <= padding[index]!; attempt++) events.push({ type: "RetryScheduled", ref, phase: "cancellation", attempt, dueAt: attempt * 100, reason: input })
        const outcome = padding[(index + 2) % padding.length]!
        if (outcome === 1) events.push({ type: "CancellationSettled", ref, outcome: reverse ? { status: "rejected", reason: "cleanup failed" } : { status: "fulfilled" } })
        if (outcome === 2) events.push({ type: "CancellationDied", ref, diagnostic: "cleanup defect" })
      }
      events.push({ type: "Tick", value: step })
      return events
    })
    for (const selector of order) {
      const event = queues[selector % queues.length]!.shift()
      if (event) append(event)
    }
    for (const queue of queues) for (const event of queue) append(event)
    for (const index of indices) {
      const ref = refs.find(ref => ref.atom === names[index])!
      if (modes[index] === "pending") append({ type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: input } } })
      if (modes[index] === "deferred") append({ type: "PromiseSettled", ref, result: { status: "fulfilled", value: input } })
    }
    refs.push({ seq: current.position, atom: "suffix", act: Job.name }, { seq: current.position + 1, atom: "missing", act: Job.name })
    const before = evaluations
    for (const snapshot of snapshots) answers(snapshot)
    if (evaluations !== before) throw new Error("Prefix lookups rebuilt an engine")
    for (const snapshot of snapshots) check(snapshot)

    const prefix = snapshots.find(snapshot => snapshot.position === refs[0]!.seq + 1)!
    const settlement = { type: "EffectSettled" as const, ref: refs[0]!, outcome: { status: "fulfilled" as const, value: { type: "value", value: input } } }
    const committedView = prefix.view()
    const prepared = log.prepare(prefix, settlement)
    if (prepared.previous !== prefix || prepared.next === prefix || prepared.records.length !== 2 || prepared.records[1]!.event.type !== "Finished") throw new Error("Preparation did not capture settlement and callback together")
    if (prefix.view() !== committedView || !prefix.effect(refs[0]!) || prepared.next.effect(refs[0]!)) throw new Error("Preparation changed the committed operation frame")
    log.discard(prepared.next)
    const retry = log.prepare(prefix, settlement)
    if (!isDeepStrictEqual(retry.records, prepared.records) || !isDeepStrictEqual(retry.next.view(), prepared.next.view())) throw new Error("Discarded preparation changed a later retry")
    const published = log.publish(retry)
    const folded = reductions
    prefix.get(Job.pending)
    prefix.checkpoint()
    published.get(Job.pending)
    published.checkpoint()
    if (reductions !== folded) throw new Error("Runtime frame restoration folded committed events again")
    check(prefix)
    check(published)
    let branch = log.append(prefix, { type: "EffectCancelled", ref: refs[0]!, reason: "branch" })
    const branchPrefix = branch
    branch = log.append(branch, { type: "Tick", value: -1 })
    check(branchPrefix)
    check(branch)
    check(current)

    const checkpoint = current.checkpoint()
    const recovered = checkpoint ? open(decodeCheckpoint(encodeCheckpoint(checkpoint))) : open()
    try {
      const initial = checkpoint ? recovered.initial : recovered.replay(current.records)
      const ref = refs.find(ref => ref.atom === "suffix")!
      const suffix = [initial]
      const advance = (event: JournalEvent<typeof Event.Type>) => suffix.push(recovered.append(suffix.at(-1)!, event))
      advance({ type: "EffectRequested", ref, request: { act: Job.name, input: { _tag: "InlineInput", value: input } } })
      advance({ type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "promise", handle: { executor: "test", id: "suffix" } } } })
      advance({ type: "PromiseSettled", ref, result: { status: "fulfilled", value: input } })
      advance({ type: "Tick", value: 2 })
      const before = evaluations
      for (const snapshot of suffix) answers(snapshot)
      if (evaluations !== before) throw new Error("Recovered prefix lookups rebuilt an engine")
      for (const snapshot of suffix) check(snapshot)
      recovered.discard(suffix.at(-1)!)
      check(initial)
      check(suffix.at(-1)!)
    } finally { recovered.dispose() }

    const beforeDiscard = reductions
    log.discard(current)
    check(prefix)
    check(current)
    if (reductions !== beforeDiscard) throw new Error("Discarded snapshot recovery replayed its durable history")
  } finally { log.dispose(); for (const oracle of oracles.values()) oracle.dispose() }
})

function journalFrame(input: Schema.Json, values: readonly number[]) {
  const history: Recorded<typeof Event.Type>[] = []
  const journal = memoryJournalReads(() => history)
  let largestRead = 0
  const readRange = (from: number, to: number) => { largestRead = Math.max(largestRead, to - from); return journal.readRange(from, to) }
  const state = durableAtom({ name: "journal.total", input: Tick, schema: Schema.Finite, initial: 0, reduce: (state, event) => state * 2 + event.value })
  const hidden = durableAtom({ name: "journal.hidden", input: Tick, schema: Schema.Finite, initial: 0, reduce: (state, event) => state * 2 + event.value })
  const done = durableAtom({ name: "journal.done", input: Finished, schema: Schema.Boolean, initial: false, reduce: () => true })
  const request = Job.request({ input, onSettled: () => [{ type: "Finished", atom: "journal" }] })
  const options = { schema: Event, journalReadBatchSize: 2, readRange, readOperation: journal.readOperation, atoms: { root: effectAtom(get => ({ view: get(state), events: {}, acts: get(done) ? {} : { job: request } })) } }
  const log = createEventLog(options)
  const restored = createEventLog(options)
  try {
    let current = log.initial
    const advance = (event: JournalEvent<typeof Event.Type>) => {
      const prepared = log.prepare(current, event)
      if (current.retainedRecords !== 0 || prepared.next.retainedRecords !== prepared.records.length) throw new Error("Runtime history exceeded its current commit batch")
      history.push(...prepared.records)
      current = log.publish(prepared)
      if (current.retainedRecords !== 0) throw new Error("Published frame retained its commit batch")
    }
    const ref = { atom: "root", act: Job.name, seq: 0 }
    advance(log.requestEvent(ref, request.request))
    let expected = 0
    let prefix = current
    let prefixValue = 0
    for (const [index, value] of values.entries()) {
      advance({ type: "Tick", value })
      expected = expected * 2 + value
      if (current.checkpoint() !== undefined || current.pending().length !== 1 || current.view().root.view !== expected) throw new Error("History release changed active work or actor state")
      if (index === 0) { prefix = current; prefixValue = expected }
    }
    if (current.get(hidden) !== expected || prefix.get(hidden) !== prefixValue) throw new Error("Journal-backed lazy reads crossed snapshot positions")
    const replayed = restored.replay(new RangeLog(history.length, readRange, 2))
    if (replayed.retainedRecords !== 0 || replayed.view().root.view !== expected || replayed.pending().length !== 1 || largestRead > 2) throw new Error("Incremental recovery retained history or exceeded its read batch")
    const failed = log.prepare(current, { type: "Tick", value: 42 })
    log.discard(failed.next)
    if (current.get(state) !== expected || current.retainedRecords !== 0) throw new Error("Discarded batch changed its published frame")
    advance({ type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: input } } })
    if (current.pending().length || !current.checkpoint() || !isDeepStrictEqual(current.records.slice(), history)) throw new Error("Journal-backed history lost settlement or callback records")
    if (!isDeepStrictEqual(prefix.records.slice(), history.slice(0, prefix.position))) throw new Error("Historical journal view included future events")
  } finally { log.dispose(); restored.dispose() }
}

function callbackFrame(input: Schema.Json, values: readonly number[]) {
  const state = durableAtom({ name: "frame.callback", input: Tick, schema: Schema.Array(Schema.Finite), initial: [], reduce: (state, event) => [...state, event.value] })
  const log = createEventLog({ schema: Event, atoms: { root: effectAtom(get => {
    const view = get(state)
    return { view, events: {}, acts: { job: Job.request({ input, onSettled: () => [{ type: "Tick", value: view.length }] }) } }
  }) } })
  try {
    let current = log.append(log.initial, { type: "Tick", value: values[0]! })
    const ref = { atom: "root", act: Job.name, seq: current.position }
    const proposed = current.effects()[0]!
    current = log.append(current, log.requestEvent(ref, proposed.request))
    for (const value of values.slice(1)) {
      const prepared = log.prepare(current, { type: "Tick", value })
      current = log.publish(prepared)
      if (current.bindings.size > 2) throw new Error("Frame forks retained superseded proposal identities")
    }
    log.discard(current)
    const prepared = log.prepare(current, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: input } } })
    if (!isDeepStrictEqual(prepared.next.get(state), [...values, 1]) || !isDeepStrictEqual(current.get(state), values)) throw new Error("Frame restoration replaced the accepted callback or changed its base state")
  } finally { log.dispose() }
}

function immutable(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  if (!Object.isFrozen(value)) throw new Error("Snapshot request or operation contains mutable data")
  Object.values(value).forEach(immutable)
}

function rejects(run: () => unknown): void {
  try { run() } catch { return }
  throw new Error("Live request trust bypassed event validation")
}
