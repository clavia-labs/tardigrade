import * as fc from "fast-check"
import { Schema } from "effect"
import { act, createEventLog, durableAtom, effectAtom, effectKey, encodeCheckpoint, decodeCheckpoint, type EffectCheckpoint, type EffectRef, type JournalEvent } from "@clavia/tardigrade-core"
import { isDeepStrictEqual } from "node:util"

const Tick = Schema.Struct({ type: Schema.Literal("Tick"), value: Schema.Finite })
const Finished = Schema.Struct({ type: Schema.Literal("Finished"), atom: Schema.String })
const Event = Schema.Union([Tick, Finished])
const Job = act({ name: "test.snapshot", input: Schema.Json, success: Schema.Json, failure: Schema.String })
const mode = fc.constantFrom("pending", "value", "failure", "deferred", "promise", "cancel", "cancelPromise")

// snapshotLookups checks prefix isolation, retirement, branches, disposal, and checkpoint recovery against independent replay; unfinished work matches journal facts (core/quint/checkpoint/acceptanceBinding.qnt, activeOnly, admissionSound).
export const snapshotLookups = fc.property(fc.jsonValue(), fc.array(mode, { minLength: 2, maxLength: 8 }), fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 8, maxLength: 8 }), fc.boolean(), fc.array(fc.nat(), { maxLength: 40 }), (value, modes, padding, reverse, order) => {
  const input = Schema.decodeUnknownSync(Schema.Json)(value)
  const names = modes.map((_, index) => `job${index}`)
  const indices = [...modes.keys()]
  if (reverse) indices.reverse()
  let evaluations = 0
  const open = (checkpoint?: EffectCheckpoint) => createEventLog({ schema: Event, ...(checkpoint ? { checkpoint } : {}), digestMinBytes: reverse ? 0 : Number.MAX_SAFE_INTEGER,
    atoms: Object.fromEntries([...names, "suffix"].map(name => {
      const request = Job.request({ input, onSettled: () => [{ type: "Finished", atom: name }] })
      const done = durableAtom({ name: `${name}.done`, input: Finished, schema: Schema.Boolean, initial: false, reduce: (state, event) => state || event.atom === name })
      if (typeof request.request.input === "object" && request.request.input !== null) Object.freeze(request.request.input)
      return [name, effectAtom(get => { evaluations++; return { view: { done: get(done) }, events: {}, acts: get(done) ? {} : { job: request } } })]
    })),
  })
  const log = open()
  type Snapshot = ReturnType<typeof log.replay>
  const refs: EffectRef[] = []
  const snapshots: Snapshot[] = [log.initial]
  let current = snapshots[0]!
  const append = (event: JournalEvent<typeof Event.Type>) => { current = log.append(current, event); snapshots.push(current) }
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
    const retained = requestsFor(snapshot).filter(request => snapshot.effect(request.ref)).map(request => effectKey(request.ref)).sort()
    if (!isDeepStrictEqual(retained, [...work.pending, ...work.deferred, ...work.cleanup].sort())) throw new Error(`Retained operations differ from unfinished work at ${snapshot.position}`)
    for (const request of requestsFor(snapshot)) immutable(snapshot.effect(request.ref))
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

    log.discard(current)
    check(prefix)
    check(current)
  } finally { log.dispose(); for (const oracle of oracles.values()) oracle.dispose() }
})

function immutable(value: unknown): void {
  if (typeof value !== "object" || value === null) return
  if (!Object.isFrozen(value)) throw new Error("Snapshot request or operation contains mutable data")
  Object.values(value).forEach(immutable)
}

function rejects(run: () => unknown): void {
  try { run() } catch { return }
  throw new Error("Live request trust bypassed event validation")
}
