import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxParked, sandboxReturned } from "@clavia/tardigrade-code/sandbox"
import { cloudflareSandboxServiceFor, type SandboxBridgeBinding } from "./sandbox"

describe("cloudflare sandbox bridge", () => {
  test("forwards package calls and closes the capability", async () => {
    let closed = false
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const bridge = (worker.env as { readonly BRIDGE: SandboxBridgeBinding }).BRIDGE
            const input = worker.env as { readonly BRIDGE: SandboxBridgeBinding; readonly INPUT: { readonly execution: string } }
            const [outcome] = await bridge.sandboxCallBatch(input.INPUT.execution, [{
              ordinal: 0,
              packageName: "tools",
              method: "add",
              args: { left: 2, right: 3 }
            }])
            if (outcome === undefined) return Response.json({ error: "missing outcome" })
            return Response.json(outcome._tag === "Parked" ? { error: "parked" } : { result: outcome.result })
          }
        })
      })
    } as unknown as WorkerLoader
    const sandbox = cloudflareSandboxServiceFor(loader, (call) => ({
      binding: {
        sandboxCallBatch: (_execution, calls) => Promise.all(calls.map((entry) =>
          call(entry.ordinal, entry.packageName, entry.method, entry.args)
        ))
      },
      execution: "test-execution",
      close: () => {
        closed = true
      }
    }))
    const result = await Effect.runPromise(sandbox.run("return 0", {
      tools: {
        add: async (input) => {
          const pair = input as { readonly left: number; readonly right: number }
          return sandboxReturned(pair.left + pair.right)
        }
      }
    }))
    expect(result).toEqual({ result: 5 })
    expect(closed).toBe(true)
  })

  test("returns concurrent parked calls across the bridge", async () => {
    let calls = 0
    const observed: Array<{ readonly input: number; readonly ordinal: number }> = []
    const arrival = [4, 1, 3, 0, 2]
    const loader = {
      load: (worker: WorkerLoaderWorkerCode) => ({
        getEntrypoint: () => ({
          fetch: async () => {
            const bridge = (worker.env as { readonly BRIDGE: SandboxBridgeBinding }).BRIDGE
            const input = worker.env as { readonly INPUT: { readonly execution: string } }
            const outcomes = await bridge.sandboxCallBatch(input.INPUT.execution, arrival.map((index) => ({
              ordinal: index,
              packageName: "agents",
              method: "run",
              args: { index }
            })))
            return Response.json({ result: outcomes.filter((outcome) => outcome._tag === "Parked").length })
          }
        })
      })
    } as unknown as WorkerLoader
    const sandbox = cloudflareSandboxServiceFor(loader, (call) => ({
      binding: {
        sandboxCallBatch: (_execution, calls) => Promise.all(calls.map((entry) =>
          call(entry.ordinal, entry.packageName, entry.method, entry.args)
        ))
      },
      execution: "test-execution",
      close: () => undefined
    }))
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
})
