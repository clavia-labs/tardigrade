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

  // Shadowing is the harness's own defense, independent of the egress mapping the test fixture
  // states: the identifiers a body could use to name an ambient network are parameters of the
  // body, undefined (sandbox.ts, RESTRICTED_NAMES).
  test("shadows the ambient network globals in the body scope", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor)
    const result = await Effect.runPromise(sandbox.run(
      `return {
        fetch: typeof fetch,
        WebSocket: typeof WebSocket,
        WebSocketPair: typeof WebSocketPair,
        caches: typeof caches,
        self: typeof self,
        postMessage: typeof postMessage,
        process: typeof process,
        Bun: typeof Bun,
        Worker: typeof Worker,
        Function: typeof Function,
        require: typeof require,
        globalThis: typeof globalThis,
        global: typeof global,
        globalKeys: Object.keys(globalThis).length
      }`,
      {}
    ))
    expect(result).toEqual({
      result: {
        fetch: "undefined",
        WebSocket: "undefined",
        WebSocketPair: "undefined",
        caches: "undefined",
        self: "undefined",
        postMessage: "undefined",
        process: "undefined",
        Bun: "undefined",
        Worker: "undefined",
        Function: "undefined",
        require: "undefined",
        globalThis: "object",
        global: "undefined",
        globalKeys: 0
      }
    })
  })

  // nodejs_compat exposes global, Node's alias for the real global scope, so a loaded isolate
  // under that flag must not name the ambient network through it (sandbox.ts,
  // RESTRICTED_NAMES).
  test("shadows the Node global alias under nodejs_compat", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor, {
      compatibilityFlags: ["nodejs_compat"]
    })
    const result = await Effect.runPromise(sandbox.run(
      `return {
        global: typeof global,
        globalFetch: typeof global === "undefined" ? "undefined" : typeof global.fetch
      }`,
      {}
    ))
    expect(result).toEqual({ result: { global: "undefined", globalFetch: "undefined" } })
  })

  // The harness wraps the body in a nested block of the parameter-scoped function, so a body
  // that declares a scoped name itself stays parseable and reaches its own binding, while the
  // names it leaves alone keep the shadowed values (sandbox.ts, bodySource).
  test("a local declaration of a scoped name stays valid", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, bridgeFor)
    const result = await Effect.runPromise(sandbox.run(
      `const fetch = () => "local"
      return { fetch: fetch(), require: typeof require, global: typeof global }`,
      {}
    ))
    expect(result).toEqual({ result: { fetch: "local", require: "undefined", global: "undefined" } })
  })

  test("a host binding keeps its own name", async () => {
    const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, () => {
      throw new Error("replay transport must not open a capability")
    }, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run(
      `return typeof fetch === "object" ? await fetch.hello() : "shadowed"`,
      { fetch: { hello: async () => sandboxReturned("bound") } }
    ))
    expect(result).toEqual({ result: "bound" })
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
