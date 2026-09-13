import { Effect, Fiber } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxParked, sandboxReturned, type SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"
import {
  DEFAULT_WORKER_LOADER_SANDBOX_POLICY,
  workerLoaderSandboxServiceFor,
  type SandboxBridgeCall
} from "./sandbox"

type CallBatch = (calls: ReadonlyArray<SandboxBridgeCall>) => Promise<ReadonlyArray<SandboxCallOutcome>>

describe("worker loader sandbox bridge", () => {
  test("keeps the capability transport as the default", () => {
    expect(DEFAULT_WORKER_LOADER_SANDBOX_POLICY.transport).toBe("capability")
  })

  test("forwards package calls through the entrypoint", async () => {
    let disposed = false
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => {
        expect(worker.env).not.toHaveProperty("BRIDGE")
        return ({
          getEntrypoint: () => ({
            run: async (_input: unknown, callBatch: CallBatch) => {
              const [outcome] = await callBatch([{
                ordinal: 0,
                packageName: "tools",
                method: "add",
                args: { left: 2, right: 3 }
              }])
              if (outcome === undefined) return JSON.stringify({ error: "missing outcome" })
              return JSON.stringify(outcome._tag === "Parked" ? { error: "parked" } : { result: outcome.result })
            }
          }),
          dispose: () => {
            disposed = true
          }
        })
      }
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader)
    const result = await Effect.runPromise(sandbox.run("return 0", {
      tools: {
        add: async (input) => {
          const pair = input as { readonly left: number; readonly right: number }
          return sandboxReturned(pair.left + pair.right)
        }
      }
    }))
    expect(result).toEqual({ result: 5 })
    expect(disposed).toBe(true)
  })

  test("accepts an ignored legacy bridge factory", async () => {
    const loader = {
      load: () => ({
        getEntrypoint: () => ({
          run: async () => JSON.stringify({ result: "done" })
        })
      })
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader, () => {
      throw new Error("legacy bridge factory must be ignored")
    })

    expect(await Effect.runPromise(sandbox.run("return 0", {}))).toEqual({ result: "done" })
  })

  test("returns concurrent parked calls across the bridge", async () => {
    let calls = 0
    const observed: Array<{ readonly input: number; readonly ordinal: number }> = []
    const arrival = [4, 1, 3, 0, 2]
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => {
        expect(worker.env).not.toHaveProperty("BRIDGE")
        return ({
          getEntrypoint: () => ({
            run: async (_input: unknown, callBatch: CallBatch) => {
              const outcomes = await callBatch(arrival.map((index) => ({
                ordinal: index,
                packageName: "agents",
                method: "run",
                args: { index }
              })))
              return JSON.stringify({ result: outcomes.filter((outcome) => outcome._tag === "Parked").length })
            }
          })
        })
      }
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader)
    const result = await Effect.runPromise(sandbox.run("return 0", {
      agents: {
        run: async (input, ordinal) => {
          calls++
          observed.push({ input: (input as { readonly index: number }).index, ordinal })
          return sandboxParked
        }
      }
    }))
    expect(result).toEqual({ result: 5 })
    expect(calls).toBe(5)
    expect(observed).toEqual(arrival.map((index) => ({ input: index, ordinal: index })))
  })

  test("replays JSON call boundaries without opening a capability", async () => {
    let round = 0
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            expect(worker.env).not.toHaveProperty("BRIDGE")
            const input = (worker.env as { readonly INPUT: { readonly replay: ReadonlyArray<{
              readonly outcome: { readonly _tag: string; readonly result?: unknown }
            }> } }).INPUT
            if (round++ === 0) {
              expect(input.replay).toEqual([])
              return Response.json({ calls: [
                { ordinal: 0, packageName: "tools", method: "add", args: { left: 2, right: 3 } },
                { ordinal: 1, packageName: "tools", method: "add", args: { left: 5, right: 8 } }
              ] })
            }
            return Response.json({ result: input.replay.map((entry) => entry.outcome.result) })
          }
        })
      })
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader, { transport: "replay" })
    const calls: Array<number> = []
    const result = await Effect.runPromise(sandbox.run("return 0", {
      tools: {
        add: async (input, ordinal) => {
          calls.push(ordinal)
          const pair = input as { readonly left: number; readonly right: number }
          return sandboxReturned(pair.left + pair.right)
        }
      }
    }))

    expect(result).toEqual({ result: [5, 13] })
    expect(calls).toEqual([0, 1])
    expect(round).toBe(2)
  })

  test("carries a parked call into the next replay", async () => {
    let round = 0
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const replay = (worker.env as { readonly INPUT: { readonly replay: ReadonlyArray<{
              readonly outcome: { readonly _tag: string }
            }> } }).INPUT.replay
            if (round++ === 0) {
              return Response.json({ calls: [
                { ordinal: 0, packageName: "agents", method: "result", args: { thread: "child" } }
              ] })
            }
            expect(replay[0]?.outcome._tag).toBe("Parked")
            return Response.json({ error: "parked call replayed" })
          }
        })
      })
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run("return 0", {
      agents: { result: async () => sandboxParked }
    }))

    expect(result).toEqual({ error: "parked call replayed" })
    expect(round).toBe(2)
  })

  test("disposes every replay worker before loading the next round", async () => {
    let round = 0
    let live = 0
    let disposed = 0
    const loader = {
      load: () => {
        if (live !== 0) throw new Error("worker capacity exhausted")
        live++
        let released = false
        return {
          getEntrypoint: () => ({
            fetch: async () => round++ === 0
              ? Response.json({ calls: [
                  { ordinal: 0, packageName: "tools", method: "read", args: { id: 1 } }
                ] })
              : Response.json({ result: "done" })
          }),
          dispose: async () => {
            if (released) throw new Error("worker disposed twice")
            released = true
            live--
            disposed++
          }
        }
      }
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader, { transport: "replay" })
    const result = await Effect.runPromise(sandbox.run("return 0", {
      tools: { read: async () => sandboxReturned("value") }
    }))

    expect(result).toEqual({ result: "done" })
    expect(round).toBe(2)
    expect(disposed).toBe(2)
    expect(live).toBe(0)
  })

  test("disposes a failed capability worker", async () => {
    let live = 0
    let disposed = 0
    const symbolDispose = (Symbol as { readonly dispose?: symbol }).dispose
    if (symbolDispose === undefined) throw new Error("Symbol.dispose is unavailable")
    const loader = {
      load: () => {
        live++
        return {
          getEntrypoint: () => ({ run: async () => { throw new Error("unavailable") } }),
          [symbolDispose]: () => {
            live--
            disposed++
          }
        }
      }
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader)
    const result = await Effect.runPromise(sandbox.run("return 0", {}))

    expect(result).toEqual({ error: "Error: unavailable" })
    expect(disposed).toBe(1)
    expect(live).toBe(0)
  })

  test("rejects saved calls after an interrupted entrypoint run", async () => {
    const started = Promise.withResolvers<void>()
    let disposed = 0
    let invoked = 0
    let savedCallBatch: CallBatch | undefined
    const loader = {
      load: () => ({
        getEntrypoint: () => ({
          run: async (_input: unknown, callBatch: CallBatch) => {
            savedCallBatch = callBatch
            started.resolve()
            await new Promise<void>(() => undefined)
            return JSON.stringify({ result: "unreachable" })
          }
        }),
        dispose: () => {
          disposed++
        }
      })
    } as unknown as WorkerLoader
    const sandbox = workerLoaderSandboxServiceFor(loader)
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sandbox.run("return 0", {
        tools: {
          later: async () => {
            invoked++
            return sandboxReturned("called")
          }
        }
      }))
      yield* Effect.promise(() => started.promise)
      yield* Fiber.interrupt(fiber)
    })))

    expect(disposed).toBe(1)
    if (savedCallBatch === undefined) throw new Error("entrypoint did not receive callBatch")
    await expect(savedCallBatch([{
      ordinal: 0,
      packageName: "tools",
      method: "later",
      args: {}
    }])).rejects.toThrow()
    expect(invoked).toBe(0)
  })
})
