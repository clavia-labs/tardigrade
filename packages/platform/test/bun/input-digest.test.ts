import { expect, test } from "bun:test"
import { storeRequest, digestInput } from "../../../core/src/runtime/input-digest"
import { Schema } from "effect"
import { atom, EventLog, act, durableAtom, effectAtom, createEventLog, encodeCheckpoint, decodeCheckpoint } from "@clavia/tardigrade-core"
import { requests } from "@clavia/tardigrade-agent/contracts/acts"
import { Context, Effect } from "effect"
import { defineActor } from "@clavia/tardigrade-core"
import { eventLogContext } from "../../../core/src/services/event-log"
import { createTestStore } from "../properties/runtime/store"
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
    if (view.active && !request) request = Job.request({ input: { system, text: view.text }, onSettled: () => [{ type: "Finished" }] })
    return { view, events: {}, acts: view.active && request ? { call: request } : {} }
  })
  return { schema: Events, atoms: { root }, digestMinBytes }
}

const acceptedHistory = (text = "x".repeat(4096)) => {
  const log = createEventLog(setup())
  let snapshot = log.append(log.initial, { type: "Started", text })
  const offered = snapshot.effects()[0]!
  const ref = { seq: snapshot.position, atom: offered.atom, act: offered.request.act }
  snapshot = log.append(snapshot, { type: "EffectRequested", ref, request: storeRequest(offered.request) })
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
    const badExecutor = snapshot.records.map(record => record.event.type === "EffectRequested" ? { ...record, event: { ...record.event, request: { ...record.event.request, act: "changed" } } } : record)
    expect(() => restored.replay(badExecutor)).toThrow()
    const observation = replay.get(atom(get => {
      const service = Context.get(get(eventLogContext)!, EventLog)
      return { events: get(service.events), records: get(service.records!), effect: service.effect!(replay.pending()[0]!.ref) }
    }))
    const acceptance = { type: "EffectRequested" as const, ref: replay.pending()[0]!.ref, act: Job.name }
    expect(observation.events.at(-1)).toEqual(acceptance)
    expect(observation.records.at(-1)!.event).toEqual(acceptance)
    expect(observation.effect!.request).toEqual(acceptance)
    expect(replay.checkpoint()).toBeUndefined()
  } finally { log.dispose(); restored.dispose(); changed.dispose() }
})

test("settlement callbacks, input release and checkpoint restore preserve the journal prefix", () => {
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
    const finished = log.append(settled, { type: "Finished" })
    expect(finished.effect(ref)!.request.request.input).toEqual(checkpoint.effects[0]!.request.request.input)
    expect(JSON.stringify(finished.records.slice(0, settled.records.length))).toBe(before)
  } finally { log.dispose() }
})

test("inline and digest acceptance share identity", () => {
  const { log, snapshot, ref, text } = acceptedHistory("small")
  try {
    expect(snapshot.records[1]!.event).toEqual({ type: "EffectRequested", ref, request: { act: "test.digest", input: { _tag: "InlineInput", value: { system: "original", text } } } })
    const duplicate = { type: "EffectRequested" as const, ref, request: storeRequest({ act: "test.digest", input: { system: "original", text } }, 0) }
    expect(log.append(snapshot, duplicate)).toBe(snapshot)
    expect(() => log.append(snapshot, { ...duplicate, request: storeRequest({ act: "test.digest", input: { system: "wrong", text } }, 0) })).toThrow("Conflicting")
  } finally { log.dispose() }
})

test("latestOnly releases preceding domain handles", () => {
  const create = (input: string) => ({ input })
  const latest = requests(create, { latestOnly: true })
  const first = latest("first", "one")
  expect(latest("first", "one")).toBe(first)
  latest("second", "two")
  expect(latest("first", "one")).not.toBe(first)
  const all = requests(create)
  const retained = all("first", "one")
  all("second", "two")
  expect(all("first", "one")).toBe(retained)
})

test("deferred inputs survive settlement and cancellation checkpoints for recovery and cleanup", () => {
  const { log, snapshot, ref, text } = acceptedHistory()
  try {
    const submitted = log.append(snapshot, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "promise", handle: { executor: "local", id: "producer" } } } })
    const advanced = log.append(submitted, { type: "Finished" })
    expect(advanced.get(Job.pending)[0]).toEqual({ ref, handle: { executor: "local", id: "producer" } })
    expect(advanced.deferred()[0]!.request.input).toEqual({ system: "original", text })
    expect(advanced.checkpoint()).toBeUndefined()
    const cancelled = log.append(advanced, { type: "EffectCancelled", ref, reason: "stop" })
    const checkpoint = decodeCheckpoint(encodeCheckpoint(cancelled.checkpoint()!))
    expect(checkpoint.effects[0]!.request.request.input).toEqual({ _tag: "InlineInput", value: { system: "original", text } })
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
      expect(recorded.type === "EffectRequested" && recorded.request.input).toEqual(digestMinBytes === 0 ? digestInput({ system: "original", text: "payload" }) : { _tag: "InlineInput", value: { system: "original", text: "payload" } })
    } finally { await Effect.runPromise(store.close) }
  }
})

test("same-identity input changes are rejected when the retained declaration is a digest", () => {
  const state = durableAtom({ name: "identity", input: Started, schema: Schema.String, initial: "", reduce: (_, event) => event.text })
  let proposal = Job.request({ input: { system: "original", text: "x".repeat(4096) } })
  const root = effectAtom(get => ({ view: get(state), events: {}, acts: { call: proposal } }))
  const log = createEventLog({ schema: Started, atoms: { root } })
  try {
    const initial = log.initial
    proposal = { ...proposal, request: { act: Job.name, input: { system: "changed", text: "x".repeat(4096) } } }
    expect(() => log.append(initial, { type: "Started", text: "update" })).toThrow("Effect identity reused with a different request")
  } finally { log.dispose() }
})

test("digest-shaped user data is executable and invalid thresholds fail", () => {
  const JsonJob = act({ name: "json", input: Schema.Json, success: Schema.Null, failure: Schema.String })
  const request = JsonJob.request({ input: digestInput("user data") })
  const root = effectAtom(() => ({ view: null, events: {}, acts: { call: request } }))
  const log = createEventLog({ schema: Started, atoms: { root } })
  try {
    const initial = log.initial
    const offered = initial.effects()[0]!
    const ref = { seq: initial.position, atom: offered.atom, act: offered.request.act }
    const accepted = log.append(initial, { type: "EffectRequested", ref, request: storeRequest(offered.request, 0) })
    expect(accepted.effects()[0]!.request.input).toEqual(digestInput("user data"))
    const restored = log.replay(accepted.records)
    expect(restored.effects()[0]!.request.input).toEqual(digestInput("user data"))
  }
  finally { log.dispose() }
  expect(() => createEventLog({ ...setup(), digestMinBytes: -1 })).toThrow("minBytes")
})
