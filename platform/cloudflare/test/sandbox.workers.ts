import { env } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox"
import type { Env } from "../src/worker"
import { cloudflareSandboxServiceFor, type SandboxBridgeFactory } from "../src/sandbox"
import { replaySequenceWith } from "./sandbox.cases"

const bridgeFor: SandboxBridgeFactory = (_call) => ({
  binding: (env as Env).ACTORS.getByName("sandbox-test"),
  execution: "unused",
  close: () => undefined
})

const mapLoaderInput = (map: (input: unknown) => unknown): WorkerLoader => ({
  load: (worker: WorkerLoaderWorkerCode) => {
    const workerEnv = worker.env as Readonly<Record<string, unknown>>
    return (env as Env).LOADER.load({
      ...worker,
      env: { ...workerEnv, INPUT: map(workerEnv["INPUT"]) }
    })
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

describe("cloudflare sandbox", () => {
  test("runs generated code with deterministic ambient values", async () => {
    const sandbox = cloudflareSandboxServiceFor((env as Env).LOADER, bridgeFor)
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
    const sandbox = cloudflareSandboxServiceFor((env as Env).LOADER, bridgeFor, { logCapBytes: 3 })
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
    const sandbox = cloudflareSandboxServiceFor((env as Env).LOADER, bridgeFor)
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
    const sandbox = cloudflareSandboxServiceFor(mapLoaderInput(reorderObjectKeys), bridgeFor, { transport: "replay" })
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
    const sandbox = cloudflareSandboxServiceFor(mapLoaderInput(reverseRecordedOrder), bridgeFor, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run(
      `return await tools.inspect({ order: ["newest", "oldest"] })`,
      { tools: { inspect: async (input) => sandboxReturned(input) } }
    ))

    expect(result.error).toBe("nondeterministic body: replayed call 0 changed")
  })

})
