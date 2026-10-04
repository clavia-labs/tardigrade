import { describe, expect, test } from "bun:test"
import { canonicalInput, compactRequest, digestInput, sameRequest } from "../../../core/src/runtime/input-digest"
import { Schema } from "effect"
import { act, durableAtom, effectAtom, createEventLog, encodeCheckpoint, decodeCheckpoint } from "@clavia/tardigrade-core"
import { requests } from "@clavia/tardigrade-agent/contracts/acts"
import { Context, Effect } from "effect"
import { defineActor } from "@clavia/tardigrade-core"
import { createTestStore } from "../properties/runtime/store"
describe("effect input digests", () => {
  test("canonical encoding sorts nested keys, preserves arrays and counts UTF-8 bytes", () => {
    expect(canonicalInput({ z: [{ b: 2, a: 1 }], a: "é" })).toBe('{"a":"é","z":[{"a":1,"b":2}]}')
    expect(digestInput({ a: 1, b: 2 })).toEqual(digestInput({ b: 2, a: 1 }))
    expect(digestInput("é").bytes).toBe(4)
    expect(digestInput([1, 2])).not.toEqual(digestInput([2, 1]))
    expect(digestInput(null).sha256).toBe("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b")
  })

  test("threshold is inclusive, configurable, and leaves small inputs inline", () => {
    const request = { executor: "test", input: "é" }
    expect(compactRequest(request, 5)).toBe(request)
    expect(compactRequest(request, 4).input).toEqual(digestInput("é"))
    expect(compactRequest(request, 0).input).toEqual(digestInput("é"))
    for (const limit of [-1, 0.5, Infinity, NaN]) expect(() => compactRequest(request, limit)).toThrow("minBytes")
  })

  test("comparison detects changed inputs, executors and lengths in either direction", () => {
    const request = { executor: "test", input: { system: "original" } }
    const compact = compactRequest(request, 0)
    expect(sameRequest(request, compact)).toBe(true)
    expect(sameRequest(compact, request)).toBe(true)
    expect(sameRequest(compact, compact)).toBe(true)
    expect(sameRequest(compact, { ...request, executor: "other" })).toBe(false)
    expect(sameRequest(compact, { ...request, input: { system: "changed" } })).toBe(false)
    expect(sameRequest(compact, { ...request, input: { ...digestInput(request.input), bytes: 0 } })).toBe(false)
  })
})


const Started = Schema.Struct({ type: Schema.Literal("Started"), text: Schema.String })
const Finished = Schema.Struct({ type: Schema.Literal("Finished") })
const Events = Schema.Union([Started, Finished])
const Job = act({ name: "test.digest", input: Schema.Struct({ system: Schema.String, text: Schema.String }), success: Schema.String, failure: Schema.String })
const setup = (system = "original", digestMinBytes = 2048) => {
  const state = durableAtom({ name: "digest.state", input: Events, schema: Schema.Struct({ active: Schema.Boolean, text: Schema.String }),
    initial: { active: false, text: "" }, reduce: (state, event) => event.type === "Started" ? { active: true, text: event.text } : { ...state, active: false },
  })
  let request: ReturnType<typeof Job.request> | undefined
  const root = effectAtom(get => {
    const view = get(state)
    if (view.active && !request) request = Job.request({ tag: "call", input: { system, text: view.text }, onSettled: () => [{ type: "Finished" }] })
    return { view, events: {}, acts: view.active && request ? { call: request } : {} }
  })
  return { schema: Events, atoms: { root }, digestMinBytes }
}

const acceptedHistory = (text = "x".repeat(4096)) => {
  const log = createEventLog(setup())
  let snapshot = log.append(log.initial, { type: "Started", text })
  const offered = snapshot.effects()[0]!
  const ref = { seq: snapshot.position, atom: offered.source, tag: offered.id }
  snapshot = log.append(snapshot, { type: "EffectRequested", ref, request: compactRequest(offered.request) })
  return { log, snapshot, ref, text }
}

test("digest replay reconstructs pending input and rejects changed proposals before execution", () => {
  const { log, snapshot, text } = acceptedHistory()
  const restored = createEventLog(setup())
  const changed = createEventLog(setup("changed"))
  try {
    const replay = restored.replay(snapshot.records)
    expect(replay.effects()[0]!.request.input).toEqual({ system: "original", text })
    expect(replay.pending()[0]!.request.input).toEqual({ system: "original", text })
    expect(() => changed.replay(snapshot.records)).toThrow("differs from its proposal")
    const badExecutor = snapshot.records.map(record => record.event.type === "EffectRequested" ? { ...record, event: { ...record.event, request: { ...record.event.request, executor: "changed" } } } : record)
    expect(() => restored.replay(badExecutor)).toThrow("differs from its proposal")
    expect(replay.checkpoint()).toBeUndefined()
  } finally { log.dispose(); restored.dispose(); changed.dispose() }
})

test("settled checkpoints compact inputs and restore without changing the journal prefix", () => {
  const { log, snapshot: accepted, ref } = acceptedHistory()
  try {
    const settled = log.append(accepted, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: "done" } } })
    const before = JSON.stringify(settled.records)
    const checkpoint = decodeCheckpoint(encodeCheckpoint(settled.checkpoint()!))
    expect(checkpoint.effects[0]!.request.request.input).toEqual(digestInput({ system: "original", text: "x".repeat(4096) }))
    expect(JSON.stringify(settled.records)).toBe(before)
    const restored = createEventLog({ ...setup(), checkpoint })
    const changed = createEventLog({ ...setup("changed"), checkpoint })
    try {
      expect(restored.initial.position).toBe(settled.position)
      expect(() => changed.initial).toThrow("Restored effect request differs")
      expect(settled.followups(settled.events.at(-1)!)).toEqual([{ type: "Finished" }])
    } finally { restored.dispose(); changed.dispose() }
  } finally { log.dispose() }
})

test("inline histories and duplicate digest acceptance remain compatible", () => {
  const { log, snapshot, ref, text } = acceptedHistory("small")
  try {
    expect(snapshot.records[1]!.event).toEqual({ type: "EffectRequested", ref, request: { executor: "test.digest", input: { system: "original", text } } })
    const duplicate = { type: "EffectRequested" as const, ref, request: compactRequest({ executor: "test.digest", input: { system: "original", text } }, 0) }
    expect(log.append(snapshot, duplicate)).toBe(snapshot)
    expect(() => log.append(snapshot, { ...duplicate, request: compactRequest({ executor: "test.digest", input: { system: "wrong", text } }, 0) })).toThrow("Conflicting")
  } finally { log.dispose() }
})


test("latestOnly keeps same-tag identity and releases preceding handles", () => {
  const create = (input: { tag: string; input: string }) => ({ ...input })
  const latest = requests(create, { latestOnly: true })
  const first = latest({ tag: "first", input: "one" })
  expect(latest({ tag: "first", input: "one" })).toBe(first)
  latest({ tag: "second", input: "two" })
  expect(latest({ tag: "first", input: "one" })).not.toBe(first)
  const all = requests(create)
  const retained = all({ tag: "first", input: "one" })
  all({ tag: "second", input: "two" })
  expect(all({ tag: "first", input: "one" })).toBe(retained)
  const custom = requests(create, input => input.input)
  expect(custom({ tag: "one", input: "same" })).toBe(custom({ tag: "two", input: "same" }))
})

test("completed inputs are released after settlement callbacks, without changing stored records", () => {
  const { log, snapshot, ref } = acceptedHistory()
  try {
    const settled = log.append(snapshot, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: "done" } } })
    const records = JSON.stringify(settled.records)
    expect(settled.followups(settled.events.at(-1)!)).toEqual([{ type: "Finished" }])
    const finished = log.append(settled, { type: "Finished" })
    expect(finished.effect(ref)!.request.request.input).toEqual(digestInput({ system: "original", text: "x".repeat(4096) }))
    expect(JSON.stringify(finished.records.slice(0, settled.records.length))).toBe(records)
  } finally { log.dispose() }
})

test("deferred inputs survive settlement and cancellation checkpoints for recovery and cleanup", () => {
  const { log, snapshot, ref, text } = acceptedHistory()
  try {
    const submitted = log.append(snapshot, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "promise", handle: { executor: "local", id: "producer" } } } })
    const advanced = log.append(submitted, { type: "Finished" })
    expect(advanced.get(Job.pending)[0]!.input).toEqual({ system: "original", text })
    expect(advanced.deferred()[0]!.request.input).toEqual({ system: "original", text })
    expect(advanced.checkpoint()).toBeUndefined()
    const cancelled = log.append(advanced, { type: "EffectCancelled", ref, reason: "stop" })
    const checkpoint = decodeCheckpoint(encodeCheckpoint(cancelled.checkpoint()!))
    expect(checkpoint.effects[0]!.request.request.input).toEqual({ system: "original", text })
    const restored = createEventLog({ ...setup(), checkpoint })
    try { expect(restored.initial.cancelled()[0]!.request.input).toEqual({ system: "original", text }) }
    finally { restored.dispose() }
  } finally { log.dispose() }
})


test("runtime threshold overrides preserve executable inputs", async () => {
  for (const digestMinBytes of [0, 1_000_000]) {
    const definition = defineActor("digest-policy", Effect.sync(() => {
      const config = setup()
      return { atom: config.atoms.root, schema: Events }
    }))
    let received = ""
    const store = await Effect.runPromise(createTestStore({ actor: definition, actorContext: Context.pick(), effectInput: { digestMinBytes }, services: () => Job.layer(input => Effect.sync(() => {
      received = input.text
      return "done"
    })) }))
    try {
      await Effect.runPromise(store.send([{ type: "Started", text: "payload" }]))
      await Effect.runPromise(store.wait)
      expect(received).toBe("payload")
      const recorded = store.snapshot().events.find(event => event.type === "EffectRequested")!
      expect(recorded.type === "EffectRequested" && recorded.request.input).toEqual(digestMinBytes === 0 ? digestInput({ system: "original", text: "payload" }) : { system: "original", text: "payload" })
    } finally { await Effect.runPromise(store.close) }
  }
})

test("legacy large inline requests replay and compact at checkpoint capture", () => {
  const { log, snapshot, ref, text } = acceptedHistory()
  const restored = createEventLog(setup())
  try {
    const history = snapshot.records.map(record => record.event.type === "EffectRequested" ? { ...record, event: { ...record.event, request: { executor: Job.name, input: { system: "original", text } } } } : record)
    const pending = restored.replay(history)
    expect(pending.effects()[0]!.request.input).toEqual({ system: "original", text })
    const settled = restored.append(pending, { type: "EffectSettled", ref, outcome: { status: "rejected", reason: "failed" } })
    expect(settled.checkpoint()!.effects[0]!.request.request.input).toEqual(digestInput({ system: "original", text }))
    expect(settled.records[1]!.event).toEqual(history[1]!.event)
  } finally { log.dispose(); restored.dispose() }
})

test("same-identity input changes are rejected when the retained declaration is a digest", () => {
  const state = durableAtom({ name: "identity", input: Started, schema: Schema.String, initial: "", reduce: (_, event) => event.text })
  let proposal = Job.request({ tag: "same", input: { system: "original", text: "x".repeat(4096) } })
  const root = effectAtom(get => ({ view: get(state), events: {}, acts: { call: proposal } }))
  const log = createEventLog({ schema: Started, atoms: { root } })
  try {
    const initial = log.initial
    proposal = { ...proposal, request: { executor: Job.name, input: { system: "changed", text: "x".repeat(4096) } } }
    expect(() => log.append(initial, { type: "Started", text: "update" })).toThrow("Effect identity reused with a different request")
  } finally { log.dispose() }
})

test("digest-shaped user inputs and invalid replay thresholds fail explicitly", () => {
  const JsonJob = act({ name: "json", input: Schema.Json, success: Schema.Null, failure: Schema.String })
  const request = JsonJob.request({ tag: "reserved", input: digestInput("user data") })
  const root = effectAtom(() => ({ view: null, events: {}, acts: { call: request } }))
  const log = createEventLog({ schema: Started, atoms: { root } })
  try { expect(() => log.initial).toThrow("InputDigest is reserved") }
  finally { log.dispose() }
  expect(() => createEventLog({ ...setup(), digestMinBytes: -1 })).toThrow("minBytes")
})
