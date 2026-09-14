import { env } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox/service"
import { workerLoaderSandboxServiceFor } from "../src/sandbox"
import type { Env } from "./fixture.worker"
import {
  ISOLATED_CALLBACK_TRANSPORT,
  sandboxSequenceWith,
  sandboxLargeReplayWith,
  type IsolatedCallbackTransportResult
} from "./sandbox.cases"

const mapLoaderInput = (map: (input: unknown) => unknown): WorkerLoader => ({
  load: (worker: WorkerLoaderWorkerCode) => {
    const loaded = (env as Env).LOADER.load(worker)
    return {
      getEntrypoint: () => ({
        fetch: async (request: Request) => loaded.getEntrypoint().fetch(new Request(request, {
          method: "POST",
          body: JSON.stringify(map(await request.json()))
        }))
      }),
      [Symbol.dispose]: () => loaded[Symbol.dispose]?.()
    }
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
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER)
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
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, { logCapBytes: 3 })
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
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER)
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
    const { result, observed } = await sandboxSequenceWith((env as Env).LOADER)

    expect(result).toEqual({ result: [12, 10] })
    expect(observed).toEqual([
      { ordinal: 0, value: 3 },
      { ordinal: 1, value: 6 },
      { ordinal: 2, value: 5 }
    ])
  })

  /*
   * The fixture model captures the observed remote limit absent from local workerd.
   * At 3367407, local workerd completed 20 executions and 60 namespace callbacks;
   * Cloudflare rejected execution 15 after 42 callbacks with a subrequest depth error.
   * The budget of 14 models this fixture, not Cloudflare's complete hop accounting.
   * With direct callbacks, both runtimes completed 20 executions and 60 package calls
   * with zero namespace callbacks; the remote run had this model disabled.
   * https://developers.cloudflare.com/workers/observability/errors/#loop-limit
   */
  test.each([
    { name: "native runtime", options: {} },
    { name: "modeled remote limit", options: { modeledExecutionLimit: 14 } }
  ])("avoids durable object reentry with $name", async ({ name, options }) => {
    const result: IsolatedCallbackTransportResult = await (env as Env).BRIDGE
      .getByName(name)
      .runIsolatedCallbackTransport(options)

    expect(result).toEqual({
      executions: ISOLATED_CALLBACK_TRANSPORT.executions,
      packageCalls: ISOLATED_CALLBACK_TRANSPORT.executions * ISOLATED_CALLBACK_TRANSPORT.callsPerExecution,
      callbackIngress: 0,
      resultMarkers: ISOLATED_CALLBACK_TRANSPORT.executions * ISOLATED_CALLBACK_TRANSPORT.callsPerExecution
    })
  })

  test("replay ignores object member order across the loader boundary", async () => {
    const sandbox = workerLoaderSandboxServiceFor(mapLoaderInput(reorderObjectKeys), { transport: "replay" })
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
    const sandbox = workerLoaderSandboxServiceFor(mapLoaderInput(reverseRecordedOrder), { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run(
      `return await tools.inspect({ order: ["newest", "oldest"] })`,
      { tools: { inspect: async (input) => sandboxReturned(input) } }
    ))

    expect(result.error).toBe("nondeterministic body: replayed call 0 changed")
  })

  test.each([2_000, 200_000])("replays twelve sequential tool results of %i bytes without duplicate calls", async (bytes) => {
    const { result, calls } = await sandboxLargeReplayWith((env as Env).LOADER, bytes)
    expect(result).toEqual({ result: 12 * bytes })
    expect(calls).toEqual(Array.from({ length: 12 }, (_, index) => index))
  })

})
