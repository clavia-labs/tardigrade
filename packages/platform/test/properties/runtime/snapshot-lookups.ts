import * as fc from "fast-check"
import { Schema } from "effect"
import { act, createEventLog, effectAtom, encodeCheckpoint, decodeCheckpoint, type EffectCheckpoint, type EffectRef, type JournalEvent } from "@clavia/tardigrade-core"
import { isDeepStrictEqual } from "node:util"

const Tick = Schema.Struct({ type: Schema.Literal("Tick"), value: Schema.Finite })
const Job = act({ name: "test.snapshot", input: Schema.Json, success: Schema.Json, failure: Schema.String })
const mode = fc.constantFrom("value", "failure", "promise", "cancel", "cancelPromise")

// snapshotLookups checks prefix isolation, retirement, branches, disposal, and checkpoint recovery against independent replay.
export const snapshotLookups = fc.property(fc.jsonValue(), fc.tuple(mode, mode), fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 8, maxLength: 8 }), fc.boolean(), (value, modes, padding, reverse) => {
  const input = Schema.decodeUnknownSync(Schema.Json)(value)
  let evaluations = 0
  const open = (checkpoint?: EffectCheckpoint) => createEventLog({ schema: Tick, ...(checkpoint ? { checkpoint } : {}), digestMinBytes: reverse ? 0 : Number.MAX_SAFE_INTEGER,
    atoms: Object.fromEntries(["left", "right", "suffix"].map(name => {
      const request = Job.request({ input })
      if (typeof request.request.input === "object" && request.request.input !== null) Object.freeze(request.request.input)
      return [name, effectAtom(() => { evaluations++; return { view: null, events: {}, acts: { job: request } } })]
    })),
  })
  const log = open()
  type Snapshot = ReturnType<typeof log.replay>
  const refs: EffectRef[] = []
  const snapshots: Snapshot[] = [log.initial]
  let current = snapshots[0]!
  const append = (event: JournalEvent<typeof Tick.Type>) => { current = log.append(current, event); snapshots.push(current) }
  let step = 0
  const pad = () => { for (let i = 0; i < padding[step++ % padding.length]!; i++) append({ type: "Tick", value: step }) }
  const answers = (snapshot: Snapshot) => refs.map(ref => ({ effect: snapshot.effect(ref), promise: snapshot.promise(ref), retry: snapshot.retry(ref) }))
  const expected = new WeakMap<Snapshot, ReturnType<typeof answers>>()
  const oracles = new Map<EffectCheckpoint | undefined, ReturnType<typeof open>>()
  const check = (snapshot: Snapshot) => {
    let lookup = expected.get(snapshot)
    if (!lookup) {
      let oracle = oracles.get(snapshot.seed)
      if (!oracle) { oracle = open(snapshot.seed); oracles.set(snapshot.seed, oracle) }
      lookup = answers(oracle.replay(snapshot.records))
      expected.set(snapshot, lookup)
    }
    if (!isDeepStrictEqual(answers(snapshot), lookup)) throw new Error(`Snapshot lookup differs from replay at ${snapshot.position}`)
  }
  try {
    for (const index of reverse ? [1, 0] : [0, 1]) {
      pad()
      const ref = { seq: current.position, atom: index === 0 ? "left" : "right", act: Job.name }
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
      const selected = modes[index]!
      if (selected === "cancel") append({ type: "EffectCancelled", ref, reason: input })
      else {
        append({ type: "EffectSettled", ref, outcome: selected === "failure" ? { status: "rejected", reason: "failed" } : { status: "fulfilled", value: selected === "value" ? { type: "value", value: input } : { type: "promise", handle: { executor: "test", id: ref.atom } } } })
        pad()
        if (selected === "cancelPromise") append({ type: "EffectCancelled", ref, reason: input })
        if (selected === "promise" || selected === "cancelPromise") append({ type: "PromiseSettled", ref, result: { status: "fulfilled", value: input } })
      }
      append({ type: "Tick", value: step })
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
    if (!checkpoint) throw new Error("Completed lifecycle did not checkpoint")
    const recovered = open(decodeCheckpoint(encodeCheckpoint(checkpoint)))
    try {
      const initial = recovered.initial
      const ref = refs.find(ref => ref.atom === "suffix")!
      const suffix = [initial]
      const advance = (event: JournalEvent<typeof Tick.Type>) => suffix.push(recovered.append(suffix.at(-1)!, event))
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
  if (!Object.isFrozen(value)) throw new Error("Trusted request contains mutable data")
  Object.values(value).forEach(immutable)
}

function rejects(run: () => unknown): void {
  try { run() } catch { return }
  throw new Error("Live request trust bypassed event validation")
}
