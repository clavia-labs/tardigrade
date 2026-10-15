import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import * as fc from "fast-check"
import { createActorStore, defineActor, ReplayContext, encodeCheckpoint, checkpointDigest, type EffectCheckpoint, type Recorded } from "@clavia/tardigrade-core"
import { Generate, Summarize } from "@clavia/tardigrade-agent/contracts/acts"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { bunJournal } from "../../src/bun"
import { agentLog, agentProjection, selection, turn } from "../fixtures/agent"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"

function legacyHistory(records: readonly Recorded<Event>[]): Recorded<Event>[] {
  const positions = new Map<number, number>()
  let removed = 0
  for (const [position, { event }] of records.entries()) {
    positions.set(position, position - removed)
    if (event.type === "ModelConfigured" || event.type === "ModelUpdated") removed++
  }
  return records.flatMap((record): Recorded<Event>[] => {
    const event = record.event
    if (event.type === "ModelConfigured" || event.type === "ModelUpdated") return []
    if (event.type === "AbortRequested" || !("ref" in event)) return [record]
    return [{ ...record, event: { ...event, ref: { ...event.ref, seq: positions.get(event.ref.seq)! },
      ...(event.type === "EffectRequested" && event.origin !== undefined ? { origin: positions.get(event.origin)! } : {}),
    } }]
  })
}

function compatibleLog(window: number, records: readonly Recorded<Event>[], checkpoint?: EffectCheckpoint) {
  const context = Context.add(Context.make(ModelInfo, { ...selection, contextWindowTokens: window }), ReplayContext, {
    records: checkpoint ? records.slice(checkpoint.position) : records,
    readFull: Effect.succeed(records), ...(checkpoint ? { checkpoint } : {}),
  })
  return agentLog(window, checkpoint, context)
}

test("compaction preserves accepted work when old threads adopt model configuration", () => fc.assert(fc.property(
  fc.integer({ min: 1_000, max: 8_000 }),
  fc.integer({ min: 2, max: 8 }),
  fc.integer({ min: 1_000, max: 32_000 }),
  (window, multiplier, hostWindow) => {
    const original = agentLog(window)
    try {
      let snapshot = turn(original, original.initial, "one", "x".repeat(window * 2))
      snapshot = turn(original, snapshot, "two", "x".repeat(window * 2))
      snapshot = original.append(snapshot, { type: "ModelUpdated", ...selection, contextWindowTokens: window * multiplier })
      snapshot = turn(original, snapshot, "three", "x".repeat(window * 2))
      const history = legacyHistory(snapshot.records.slice())
      const restored = compatibleLog(hostWindow, history)
      try {
        const pending = history.findIndex(({ event }) => event.type === "ModelCalled" && event.purpose === "compaction")
        expect(pending).toBeGreaterThanOrEqual(0)
        const prefix = restored.replay(history.slice(0, pending + 1))
        expect(prefix.pending()[0]?.request.act).toBe("agent.model.summarize")
        const captured = restored.replay(history.slice(0, pending - 1)).checkpoint()!
        const checkpoint = { ...captured, durable: captured.durable.filter(entry => entry.name !== "agent.model") }
        const suffix = compatibleLog(hostWindow, history, checkpoint)
        try { expect(suffix.replay(history.slice(checkpoint.position)).records.slice()).toEqual(history.slice(checkpoint.position)) }
        finally { suffix.dispose() }
        for (let end = 1; end < history.length; end++) {
          const prefix = restored.replay(history.slice(0, end))
          expect(Object.values(prefix.view().agent.events).some(proposal => proposal.event.type === "ModelConfigured")).toBe(false)
        }
        let loaded = restored.replay(history)
        const configuration = Object.values(loaded.view().agent.events).find(proposal => proposal.event.type === "ModelConfigured")!
        expect(configuration.event).toEqual({ type: "ModelConfigured", model: selection.model, contextWindowTokens: hostWindow })
        loaded = restored.append(loaded, configuration.event)
        expect(loaded.records.slice(0, history.length)).toEqual(history)
        const next = turn(restored, loaded, "next", "Continue")
        const called = next.records.slice(history.length).flatMap(({ event }) => event.type === "ModelCalled" ? [event] : [])
        expect(called.length).toBeGreaterThan(0)
        expect(called.every(event => event.contextWindowTokens === hostWindow)).toBe(true)
      } finally { restored.dispose() }
    } finally { original.dispose() }
  },
), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("compaction resumes accepted work while old threads adopt configuration", async () => {
  const original = agentLog(2_000)
  let history: Recorded<Event>[]
  try {
    let snapshot = turn(original, original.initial, "one", "x".repeat(4_000))
    snapshot = turn(original, snapshot, "two", "x".repeat(4_000))
    const records = legacyHistory(snapshot.records.slice())
    const called = records.findIndex(({ event }) => event.type === "ModelCalled" && event.purpose === "compaction")
    history = records.slice(0, called + 1)
  } finally { original.dispose() }
  let summaries = 0
  let generations = 0
  const actor = defineActor("agent", agentProjection.pipe(Effect.map(atom => ({ atom, schema: Event }))))
  const directory = await mkdtemp(join(tmpdir(), "tardie-model-compat-"))
  const journal = bunJournal<Event>({ filename: join(directory, "thread.sqlite"), actor: "events" })
  const preparing = compatibleLog(10_000, history)
  const captured = preparing.replay(history.slice(0, history.length - 2)).checkpoint()!
  preparing.dispose()
  const checkpoint = { ...captured, durable: captured.durable.filter(entry => entry.name !== "agent.model") }
  const payload = encodeCheckpoint(checkpoint)
  await Effect.runPromise(journal.appendWithCheckpoint(0, history.slice(0, checkpoint.position), { position: checkpoint.position, payload, digest: await Effect.runPromise(checkpointDigest(payload)) }))
  await Effect.runPromise(journal.append(checkpoint.position, history.slice(checkpoint.position)))
  let fullReads = 0
  const trackedJournal = { ...journal, read: journal.read.pipe(Effect.tap(() => Effect.sync(() => { fullReads++ }))) }
  const open = () => Effect.runPromise(createActorStore({
    actor, journal: trackedJournal, actorContext: Context.pick(ModelInfo),
    checkpoint: { mode: "threshold", options: { everyEvents: 1 } },
    services: () => Layer.mergeAll(
      Layer.succeed(ModelInfo, { ...selection, contextWindowTokens: 10_000 }),
      Generate.layer(() => Effect.sync(() => { generations++; return { text: "Answer", toolCalls: [] } })),
      Summarize.layer(() => Effect.sync(() => { summaries++; return { text: "Summary", toolCalls: [] } })),
    ),
  }))
  let store = await open()
  try {
    await Effect.runPromise(store.wait)
    expect(summaries).toBe(1)
    expect(generations).toBe(1)
    const records = (await Effect.runPromise(journal.read)).slice()
    expect(records.slice(0, history.length)).toEqual(history)
    expect(records.filter(({ event }) => event.type === "ModelConfigured")).toHaveLength(1)
    expect(fullReads).toBe(1)
    await Effect.runPromise(store.close)
    store = await open()
    await Effect.runPromise(store.wait)
    expect(summaries).toBe(1)
    expect(generations).toBe(1)
    expect(await Effect.runPromise(journal.read)).toEqual(records)
    expect(fullReads).toBe(1)
  } finally {
    await Effect.runPromise(store.close.pipe(Effect.ensuring(journal.close)))
    await rm(directory, { recursive: true, force: true })
  }
})
