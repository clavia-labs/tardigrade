import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { ActorEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import type { MessageReceived } from "@clavia/tardigrade-core/communication/message"
import { Ingress } from "@clavia/tardigrade-host/ingress"
import { RESERVED_ACTOR } from "@clavia/tardigrade-client/contract"
import { Infer, type InferRequest } from "tardie"
import type { Action } from "tardie/events"

import { layerConfig, readConfig, ServerConfig } from "./config"
import { Threads, layerThreads, selectedModelFrom } from "./host"
import { DriverGauge } from "./http"
import { layerModelCatalogUnavailable } from "./catalog"

// Every case here opens a real store on disk and drives a real host, so it competes with every
// other task in a parallel gate run. Bun's default per-test budget is tuned for a pure function and
// times out under that load; this is the budget a boot actually needs. It stays tight on purpose: a
// case that wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// The host service against a real durable host on a volatile database, with the model seam bound
// to a scripted mind: no credentials, no network, and the turn loop is the library's own.

// The scripted mind answers the brief in one attempt. It honors the Infer contract by ending the
// turn rather than calling a tool, which is all these assertions need
// (packages/agent/src/index.test.ts, the scripted mind).
const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String((event as { text?: unknown }).text ?? "")
  }
  return ""
}

const scripted = (request: InferRequest): Action => ({ kind: "complete", output: `ok: ${briefOf(request.trajectory)}` })

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: (request: InferRequest) => Effect.succeed(scripted(request))
})

// The database is ":memory:", so each test opens its own store and closes it with the scope.
const config = layerConfig(readConfig({
  TARDIGRADE_DB: ":memory:",
  TARDIGRADE_ACTORS: `/tmp/tardigrade-host-test-${process.pid}`
}))

// The body runs with both services the layer provides: the threads it drives, and the gauge
// /healthz reads over the same driver (http.ts, DriverGauge).
const running = <A, E>(
  body: (threads: Context.Service.Shape<typeof Threads>) => Effect.Effect<A, E, DriverGauge | Ingress>,
  options: {
    readonly infer?: Layer.Layer<Infer>
    readonly config?: Layer.Layer<ServerConfig>
  } = {}
): Promise<A> =>
  Effect.gen(function*() {
    const threads = yield* Threads
    return yield* body(threads)
  }).pipe(
    Effect.provide(Layer.provide(layerThreads({
      infer: options.infer ?? layerScripted,
      providers: [{ name: "test", send: () => Effect.void }]
    }), [options.config ?? config, layerModelCatalogUnavailable])),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

// One brief, as the event it is. The platform requires only `type`; `id` and `text` are the
// assembly's fields, and `id` is the key its own `keyOf` dedups on (packages/core/src/message.ts).
const brief = (id: string, text = "hello") => ({ type: "MessageReceived", id, text })

describe("model selection", () => {
  const model = {
    default: { provider: "openrouter", model_id: "anthropic/claude-sonnet-4-6" },
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        driver: "openai-chat-completions" as const,
        env: ["OPENROUTER_API_KEY"]
      }
    }
  }
  const credentials = { OPENROUTER_API_KEY: "secret" }
  const catalog = {
    snapshot: {
      source: "models.dev" as const,
      revision: "catalog-1",
      refreshedAt: 1,
      status: "fresh" as const,
      providers: [{
        id: "openrouter",
        name: "OpenRouter",
        env: [],
        models: [
          { id: "anthropic/claude-sonnet-4-6", metadata: { contextWindowTokens: 200_000 } },
          {
            id: "openai/gpt-5.2",
            metadata: {
              contextWindowTokens: 400_000,
              maxOutputTokens: 128_000,
              pricing: { promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_004 }
            }
          }
        ]
      }]
    }
  }

  test("a connection can select any model in its catalog", () => {
    expect(selectedModelFrom(model, credentials, catalog, {
      provider: "openrouter",
      model_id: "openai/gpt-5.2"
    })).toMatchObject({
      provider: "openrouter",
      model_id: "openai/gpt-5.2",
      contextWindowTokens: 400_000,
      maxOutputTokens: 128_000,
      pricing: { promptUsdPerToken: 0.000_001, completionUsdPerToken: 0.000_004 },
      catalogRevision: "catalog-1"
    })
  })

  test("a connection uses the first available named credential", () => {
    expect(selectedModelFrom({
      ...model,
      providers: {
        openrouter: { ...model.providers.openrouter!, env: ["PRIMARY_KEY", "OPENROUTER_API_KEY"] }
      }
    }, credentials, catalog)?.apiKey).toBe("secret")
  })

  test("a connection carries its configured region", () => {
    expect(selectedModelFrom({
      ...model,
      providers: {
        openrouter: { ...model.providers.openrouter!, region: "ap-southeast-1" }
      }
    }, credentials, catalog)?.region).toBe("ap-southeast-1")
  })

  test("an unknown model names the catalog revision", () => {
    expect(() => selectedModelFrom(model, credentials, catalog, {
      provider: "openrouter",
      model_id: "missing"
    })).toThrow("catalog revision \"catalog-1\"")
  })
})

describe("the threads service", () => {
  test("retains the built-in actor methods", async () => {
    const methods = await running((threads) => Effect.succeed(Object.keys(threads.methods)))
    expect(methods).toEqual(["message"])
  })

  test("the configured lane capacity runs model calls concurrently", async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let twoStarted!: () => void
    const started = new Promise<void>((resolve) => {
      twoStarted = resolve
    })
    let active = 0
    let peak = 0
    let calls = 0
    const concurrent = Layer.succeed(Infer)({
      react: () => Effect.promise(async () => {
        active += 1
        peak = Math.max(peak, active)
        calls += 1
        if (calls === 2) twoStarted()
        await released
        active -= 1
        return { kind: "complete", output: "done" } as Action
      })
    })
    const concurrentConfig = layerConfig(readConfig({
      TARDIGRADE_DB: ":memory:",
      TARDIGRADE_ACTORS: `/tmp/tardigrade-host-concurrent-${process.pid}`,
      TARDIGRADE_MAX_CONCURRENT_LANES: "2"
    }))

    await running(
      (threads) => Effect.gen(function*() {
        yield* Effect.all([
          threads.append("alpha", brief("a")),
          threads.append("beta", brief("b"))
        ], { concurrency: "unbounded" })
        yield* Effect.promise(() => started)
        expect(active).toBe(2)
        release()
        yield* threads.settled
        expect(peak).toBe(2)
      }),
      { infer: concurrent, config: concurrentConfig }
    )
  })

  test("ingress commits a deduplicated batch before any actor is driven", async () => {
    const result = await running((threads) =>
      Effect.gen(function*() {
        const ingress = yield* Ingress
        const envelopes: ReadonlyArray<ActorEnvelope<MessageReceived>> = [
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "alpha" }
            },
            event: { type: "MessageReceived", id: "m1", text: "first", at: 42 }
          },
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "beta" }
            },
            event: { type: "MessageReceived", id: "m2", text: "second", at: 43 }
          },
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "alpha" }
            },
            event: { type: "MessageReceived", id: "m1", text: "first", at: 42 }
          }
        ]
        yield* ingress.commit(envelopes)
        const gauge = yield* DriverGauge
        const committed = {
          alpha: yield* threads.events("alpha"),
          beta: yield* threads.events("beta"),
          dirty: yield* gauge.dirty,
          resting: yield* gauge.resting
        }
        yield* ingress.schedule(envelopes)
        yield* threads.settled
        return {
          committed,
          settled: {
            alpha: yield* threads.events("alpha"),
            beta: yield* threads.events("beta")
          }
        }
      })
    )

    expect(result.committed.alpha.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(result.committed.beta.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(result.committed.dirty).toBe(2)
    expect(result.committed.resting).toBe(false)
    expect(result.settled.alpha.some((event) => event.type === "TurnCompleted")).toBe(true)
    expect(result.settled.beta.some((event) => event.type === "TurnCompleted")).toBe(true)
  })

  test("an appended brief drives to a completed turn", async () => {
    const types = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        const gauge = yield* DriverGauge
        expect(yield* gauge.dirty).toBe(0)
        expect(yield* gauge.resting).toBe(true)
        return (yield* threads.events("alpha")).map((e) => e.type)
      })
    )
    expect(types).toContain("TurnCompleted")
  })

  test("list names every thread lane with its log", async () => {
    const listed = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.append("beta", brief("m2"))
        yield* threads.settled
        return yield* threads.list
      })
    )
    expect(listed.map((entry) => entry.id)).toEqual(["alpha", "beta"])
    expect(listed.every((entry) => entry.events.some((e) => e.type === "TurnCompleted"))).toBe(true)
  })

  // The service appends whatever fact it is handed and reads none of its fields: what an event
  // means is the actor's knowledge (actor.ts, agentProjections). An append that carries its own
  // `at` keeps it, so a replayed fact keeps the time it happened.
  test("an appended event keeps the time it states", async () => {
    const stamps = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", { type: "MessageReceived", id: "m1", text: "hello", at: 4242 })
        yield* threads.settled
        const log = yield* threads.events("alpha")
        return log.filter((event) => event.type === "MessageReceived").map((event) => event["at"])
      })
    )
    expect(stamps).toEqual([4242])
  })

  test("redelivering one message id is absorbed", async () => {
    const counts = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        const before = (yield* threads.events("alpha")).length
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        return [before, (yield* threads.events("alpha")).length]
      })
    )
    expect(counts[1]).toBe(counts[0]!)
  })
})
