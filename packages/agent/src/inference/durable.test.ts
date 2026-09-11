import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { withWatermark } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { InferRequest } from "./contract"
import { canonicalInferenceJson, inferenceProviderKey, inferenceReceiptsFrom, inferenceRequestIdentity, type InferenceAttemptPosition } from "./durable"

const request = (thread = "thread"): InferRequest => ({
  trajectory: [], identity: { actor: "actor", instance: "instance", thread, turn: "turn" },
  system: "system", tools: []
})

const position: InferenceAttemptPosition = { attempt: 0, rung: 0, retry: 0 }
const prepared = { fingerprint: "sha256:request", route: { provider: "fixture", model: "model" } }
const policy = { decision: "stop" as const }

const memoryLog = (initial: ReadonlyArray<Event> = []) => {
  const events = [...initial]
  return withWatermark({
    append: (batch) => Effect.sync(() => { events.push(...batch) }),
    read: Effect.sync(() => [...events])
  })
}

const begin = (receipts: ReturnType<typeof inferenceReceiptsFrom>, requestId: string, thread = "thread") => receipts.begin({
  requestId, callId: "turn/infer/0", turn: request(thread).identity.turn, prepared, policy, position
})

describe("durable inference receipts", () => {
  test("full host and actor identity separates equal logical calls", () => {
    expect(inferenceRequestIdentity("namespace-a/run", request("first"), "turn/infer/0"))
      .not.toBe(inferenceRequestIdentity("namespace-a/run", request("second"), "turn/infer/0"))
    expect(inferenceRequestIdentity("namespace-a/run", request(), "turn/infer/0"))
      .not.toBe(inferenceRequestIdentity("namespace-b/run", request(), "turn/infer/0"))
  })

  test("provider key is a bounded digest of the full identity", async () => {
    const first = await Effect.runPromise(inferenceProviderKey(inferenceRequestIdentity("namespace/run", request("first"), "turn/infer/0")))
    const second = await Effect.runPromise(inferenceProviderKey(inferenceRequestIdentity("namespace/run", request("second"), "turn/infer/0")))
    expect(first).toMatch(/^tdg_[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  test("canonical metadata rejects lossy JSON values", () => {
    expect(() => canonicalInferenceJson({ value: Number.NaN })).toThrow("non-finite")
    expect(() => canonicalInferenceJson({ value: undefined })).toThrow("unsupported undefined")
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(() => canonicalInferenceJson(cyclic)).toThrow("cycle")
    expect(() => canonicalInferenceJson(new Date(0))).toThrow("non-plain")
    expect(() => canonicalInferenceJson(Array(1))).toThrow("sparse")
  })

  test("retains a complete action before replay and rejects request drift", async () => {
    const log = memoryLog()
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "begun" })
    const action = { kind: "complete" as const, output: "answer", usage: { promptTokens: 1, completionTokens: 2 } }
    await Effect.runPromise(receipts.retain({ requestId, turn: "turn", fingerprint: prepared.fingerprint, action }))
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({
      status: "retained", action, fingerprint: prepared.fingerprint
    })
    const drifted = receipts.begin({
      requestId, callId: "turn/infer/0", turn: "turn", prepared: { ...prepared, fingerprint: "sha256:other" }, policy, position
    })
    await expect(Effect.runPromise(drifted)).rejects.toThrow("drifted before replay")
  })

  test("replays a committed retry decision without beginning another request", async () => {
    const log = memoryLog()
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    await Effect.runPromise(begin(receipts, requestId))
    const decision = { outcome: "unknown" as const, decision: "retry" as const, error: "connection lost", next: { attempt: 1, rung: 0, retry: 1 } }
    await Effect.runPromise(receipts.decide({ requestId, turn: "turn", fingerprint: prepared.fingerprint, position, decision }))
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "decided", decision })
  })

  test("a concurrent caller cannot reinterpret live work as unknown", async () => {
    const log = memoryLog()
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "begun" })
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "inFlight" })
    const action = { kind: "complete" as const, output: "first caller" }
    await Effect.runPromise(receipts.retain({ requestId, turn: "turn", fingerprint: prepared.fingerprint, action }))
    expect(await Effect.runPromise(begin(receipts, requestId))).toMatchObject({ status: "retained", action })
  })

  test("simultaneous initial callers reserve one local admission", async () => {
    const events: Event[] = []
    const log = withWatermark({
      read: Effect.promise(async () => { await Promise.resolve(); return [...events] }),
      append: (batch) => Effect.sync(() => {
        for (const event of batch) if (!events.some((recorded) => recorded.type === event.type && (recorded as { requestId?: unknown }).requestId === (event as { requestId?: unknown }).requestId)) events.push(event)
      })
    })
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    const states = await Promise.all([Effect.runPromise(begin(receipts, requestId)), Effect.runPromise(begin(receipts, requestId))])
    expect(states.map((state) => state.status).sort()).toEqual(["begun", "inFlight"])
    expect(events.filter((event) => event.type === "InferenceRequested")).toHaveLength(1)
  })

  test("recorded ambiguity policy cannot drift before provider I/O", async () => {
    const log = memoryLog()
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    await Effect.runPromise(begin(receipts, requestId))
    const changed = receipts.begin({
      requestId, callId: "turn/infer/0", turn: "turn", prepared,
      policy: { decision: "retry" }, position
    })
    await expect(Effect.runPromise(changed)).rejects.toThrow("changed its ambiguity policy")
  })

  test("a committed request survives a lost append acknowledgment", async () => {
    const events: Event[] = []
    let lose = true
    const log = withWatermark({
      read: Effect.sync(() => [...events]),
      append: (batch) => Effect.suspend(() => {
        events.push(...batch)
        if (lose) { lose = false; return Effect.die("lost acknowledgment") }
        return Effect.void
      })
    })
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    await expect(Effect.runPromise(begin(receipts, requestId))).rejects.toBeDefined()
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "pending" })
    expect(events.filter((event) => event.type === "InferenceRequested")).toHaveLength(1)
  })

  test("a retained result survives a lost append acknowledgment", async () => {
    const events: Event[] = []
    let loseResult = true
    const log = withWatermark({
      read: Effect.sync(() => [...events]),
      append: (batch) => Effect.suspend(() => {
        events.push(...batch)
        if (loseResult && batch.some((event) => event.type === "InferenceResultRetained")) {
          loseResult = false
          return Effect.die("lost result acknowledgment")
        }
        return Effect.void
      })
    })
    const receipts = inferenceReceiptsFrom(log)
    const requestId = inferenceRequestIdentity("namespace/run", request(), "turn/infer/0")
    await Effect.runPromise(begin(receipts, requestId))
    const action = { kind: "complete" as const, output: "retained" }
    const retain = receipts.retain({ requestId, turn: "turn", fingerprint: prepared.fingerprint, action })
    await expect(Effect.runPromise(retain)).rejects.toBeDefined()
    expect(await Effect.runPromise(begin(receipts, requestId))).toEqual({ status: "retained", action, fingerprint: prepared.fingerprint })
    expect(events.filter((event) => event.type === "InferenceResultRetained")).toHaveLength(1)
  })
})
