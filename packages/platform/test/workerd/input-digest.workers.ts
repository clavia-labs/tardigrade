import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Context, Effect, Layer, Schema } from "effect"
import { createActor } from "@clavia/tardigrade-agent"
import { ModelInfo, ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { Generate, Summarize, ExecuteTool, AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import type { Event } from "@clavia/tardigrade-agent/contracts/events"
import { InputDigest } from "@clavia/tardigrade-core"
import { cloudflareJournal, DEFAULT_CHECKPOINT_CHUNK_BYTES } from "../../src/cloudflare"
import { createTestStore } from "../properties/runtime/store"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER

test("stock agent reaches 10k events with bounded SQLite checkpoints and linear journal growth", async () => {
  await runInDurableObject(namespace.getByName("input-digest-long-thread"), async (_instance, state) => {
    const journal = cloudflareJournal<Event>(state.storage, "digest-long-thread")
    const open = () => Effect.runPromise(createTestStore({ actor: createActor, journal, actorContext: Context.pick(ModelInfo, ToolCatalog), services: () => Layer.mergeAll(
      Layer.succeed(ModelInfo, { model: { provider: "openrouter", model_id: "test" }, contextWindowTokens: 1_000_000 }),
      Layer.succeed(ToolCatalog, { names: ["test.job"], specs: [{ name: "test.job", description: "Return test data", inputSchema: { type: "object" } }] }),
      Generate.layer(input => Effect.sync(() => {
        const start = input.context.findLastIndex(message => message.role === "user")
        const calls = input.context.slice(start).filter(message => message.role === "tool").length
        return calls < 8 ? { text: "", toolCalls: [{ callId: `tool:${calls}`, name: "test.job", input: {} }] } : { text: "a".repeat(160), toolCalls: [] }
      })),
      Summarize.layer(() => Effect.succeed({ text: "summary", toolCalls: [] })),
      ExecuteTool.layer(() => Effect.succeed("x".repeat(240))),
      AskPermission.layer(() => Effect.succeed({ allowed: true, reason: "test" })),
    ) }))
    let store = await open()
    await Effect.runPromise(store.wait)
    let turn = 0
    let position = store.snapshot().position
    let eventsPerTurn = 0
    const samples: { position: number; bytes: number }[] = []
    const next = async () => {
      await Effect.runPromise(store.send([{ type: "TurnRequested", source: "user", turnId: `turn:${turn++}`, text: "hello" }]))
      await Effect.runPromise(store.wait)
      const current = store.snapshot().position
      const delta = current - position
      if (eventsPerTurn) expect(delta).toBe(eventsPerTurn)
      else eventsPerTurn = delta
      position = current
    }
    try {
      while (position < 2_500) await next()
      const prefix = JSON.stringify(await Effect.runPromise(journal.read))
      const sample = () => {
        const row = state.storage.sql.exec<{ bytes: number }>("SELECT SUM(length(event)) AS bytes FROM experimental_events WHERE actor = ?", "digest-long-thread").one()
        samples.push({ position, bytes: row.bytes })
      }
      sample()
      await Effect.runPromise(store.close)
      store = await open()
      expect(JSON.stringify(await Effect.runPromise(journal.read))).toBe(prefix)
      while (position < 5_000) await next()
      sample()
      while (position < 10_000) await next()
      sample()
      const records = await Effect.runPromise(journal.read)
      const modelRequests = records.filter(record => record.event.type === "EffectRequested" && record.event.request.act === Generate.name)
      expect(modelRequests.length).toBeGreaterThan(500)
      expect(modelRequests.slice(9).every(record => record.event.type === "EffectRequested" && Schema.is(InputDigest)(record.event.request.input))).toBe(true)
      const checkpoint = state.storage.sql.exec<{ bytes: number; chunks: number; max: number; blobs: number }>("SELECT SUM(length(payload)) AS bytes, COUNT(*) AS chunks, MAX(length(payload)) AS max, SUM(typeof(payload) = 'blob') AS blobs FROM checkpoint_chunks").one()
      expect(checkpoint.chunks).toBeGreaterThan(1)
      expect(checkpoint.blobs).toBe(checkpoint.chunks)
      expect(checkpoint.max).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_CHUNK_BYTES)
      expect(samples[2]!.bytes / samples[1]!.bytes).toBeLessThan(2.2)
      expect(samples[1]!.bytes / samples[0]!.bytes).toBeLessThan(2.2)
      const view = store.getState().view
      await Effect.runPromise(store.close)
      store = await open()
      await Effect.runPromise(store.wait)
      expect(store.snapshot().position).toBe(position)
      expect(store.getState().view).toEqual(view)
      expect(await Effect.runPromise(journal.read)).toEqual(records)
      console.log(JSON.stringify({ samples, checkpointBytes: checkpoint.bytes, checkpointChunks: checkpoint.chunks, maxChunkBytes: checkpoint.max, eventsPerTurn }))
    } finally { await Effect.runPromise(store.close); await Effect.runPromise(journal.close) }
  })
}, 240_000)
