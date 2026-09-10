import { env } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox/service"
import { workerLoaderSandboxServiceFor, type SandboxBridgeFactory } from "../src/sandbox"
import type { Env } from "./fixture.worker"
import { replaySequenceWith } from "./sandbox.cases"

const bridgeFor: SandboxBridgeFactory = (_call) => ({
  binding: (env as Env).BRIDGE.getByName("sandbox-test"),
  execution: "unused",
  close: () => undefined
})

const mapLoaderInput = (map: (input: unknown) => unknown): WorkerLoader => ({
  load: (worker: WorkerLoaderWorkerCode) => {
    const stub = (env as Env).LOADER.load(worker)
    return { getEntrypoint: () => ({ fetch: async (request: Request) => {
      const input = map(await request.json())
      return stub.getEntrypoint().fetch(new Request(request, { method: request.method, body: JSON.stringify(input) }))
    } }) }
  }
}) as WorkerLoader

const reorderObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reorderObjectKeys)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, entry]) => [key, reorderObjectKeys(entry)])
  )
}

const reverseRecordedOrder = (value: unknown): unknown => {
  const input = structuredClone(value) as {
    replay?: Array<{ call?: { args?: { order?: unknown[] } } }>
  }
  const order = input.replay?.[0]?.call?.args?.order
  if (order !== undefined) order.reverse()
  return input
}

describe("worker loader sandbox", () => {
  test("runs generated code with deterministic ambient values", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor)
    const result = await Effect.runPromise(sandbox.run(
      `const [left, right] = await Promise.all([Promise.resolve(5), Promise.resolve(13)])
      console.log("totals", left, right)
      return { left, right, now: Date.now(), random: Math.random() }`,
      {
        brief: "parallel addition"
      },
      { at: 1234, seed: "sandbox-test" }
    ))
    expect(result).toEqual({
      result: { left: 5, right: 13, now: 1234, random: expect.any(Number) },
      logs: ["totals 5 13"]
    })
  })

  test("cuts captured output at the configured cap", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor, { logCapBytes: 3 })
    const result = await Effect.runPromise(sandbox.run(
      `console.log("four")
      console.log("later")
      return brief`,
      { brief: "done" }
    ))
    expect(result).toEqual({
      result: "done",
      logs: ["four", "…[console output cut at 3 bytes; later lines dropped]"]
    })
  })

  test("blocks ambient network access", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor)
    const result = await Effect.runPromise(sandbox.run(
      `try {
        await fetch("https://example.com")
        return "reachable"
      } catch (_error) {
        return "blocked"
      }`,
      {}
    ))
    expect(result).toEqual({ result: "blocked" })
  })

  test("replays sequential and concurrent package calls", async () => {
    const { result, observed } = await replaySequenceWith((env as Env).LOADER)

    expect(result).toEqual({ result: [12, 10] })
    expect(observed).toEqual([
      { ordinal: 0, value: 3 },
      { ordinal: 1, value: 6 },
      { ordinal: 2, value: 5 }
    ])
  })

  test("replay ignores object member order across the loader boundary", async () => {
    const sandbox = workerLoaderSandboxServiceFor(mapLoaderInput(reorderObjectKeys), bridgeFor, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run(
      `return await tools.inspect({
        tool: "list_deployments",
        parameters: { region: "us", filters: { owner: "me", status: "active" } },
        order: ["newest", "oldest"]
      })`,
      { tools: { inspect: async (input) => sandboxReturned(input) } }
    ))

    expect(result).toEqual({
      result: {
        tool: "list_deployments",
        parameters: { region: "us", filters: { owner: "me", status: "active" } },
        order: ["newest", "oldest"]
      }
    })
  })

  test("replay keeps argument array order significant", async () => {
    const sandbox = workerLoaderSandboxServiceFor(mapLoaderInput(reverseRecordedOrder), bridgeFor, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run(
      `return await tools.inspect({ order: ["newest", "oldest"] })`,
      { tools: { inspect: async (input) => sandboxReturned(input) } }
    ))

    expect(result.error).toBe("nondeterministic body: replayed call 0 changed")
  })

  test("replays tool results above the environment binding limit", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor, { transport: "replay" })
    const text = "x".repeat(200_000)
    const ordinals: number[] = []
    const result = await Effect.runPromise(sandbox.run(
      `let characters = 0; for (let index = 0; index < 12; index++) {
        const text = await tools.read({ index }); characters += text.length;
      } return characters`,
      { tools: { read: async (_input, ordinal) => { ordinals.push(ordinal); return sandboxReturned(text) } } }
    ))
    expect(result).toEqual({ result: 2_400_000 })
    expect(ordinals).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

})
