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
  const open = (checkpoint?: EffectCheckpoint) => createEventLog({ schema: Tick, ...(checkpoint ? { checkpoint } : {}), digestMinBytes: 0,
    atoms: Object.fromEntries(["left", "right", "suffix"].map(name => {
      const request = Job.request({ input })
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
  const answers = (snapshot: Snapshot) => refs.map(ref => ({ effect: snapshot.effect(ref), promise: snapshot.promise(ref) }))
  const check = (snapshot: Snapshot) => {
    const oracle = open(snapshot.seed)
    try {
      const expected = answers(oracle.replay(snapshot.records))
      if (!isDeepStrictEqual(answers(snapshot), expected)) throw new Error(`Snapshot lookup differs from replay at ${snapshot.position}`)
    } finally { oracle.dispose() }
  }
  try {
    for (const index of reverse ? [1, 0] : [0, 1]) {
      pad()
      const ref = { seq: current.position, atom: index === 0 ? "left" : "right", act: Job.name }
      refs.push(ref)
      append({ type: "EffectRequested", ref, request: { act: Job.name, input: { _tag: "InlineInput", value: input } } })
      pad()
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
    refs.push({ seq: current.position + 1, atom: "missing", act: Job.name })
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
      const ref = { seq: initial.position, atom: "suffix", act: Job.name }
      refs.push(ref)
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
      for (const snapshot of suffix) check(snapshot)
    } finally { recovered.dispose() }

    log.discard(current)
    for (const snapshot of snapshots) check(snapshot)
  } finally { log.dispose() }
})
