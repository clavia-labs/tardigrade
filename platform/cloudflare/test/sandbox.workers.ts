import { env } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox"
import type { Env } from "../src/worker"
import { cloudflareSandboxServiceFor, type SandboxBridgeFactory } from "../src/sandbox"

const bridgeFor: SandboxBridgeFactory = (_call) => ({
  binding: (env as Env).ACTORS.getByName("sandbox-test"),
  execution: "unused",
  close: () => undefined
})

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
    const sandbox = cloudflareSandboxServiceFor((env as Env).LOADER, bridgeFor, { transport: "replay" })
    const observed: Array<{ readonly ordinal: number; readonly value: number }> = []
    const result = await Effect.runPromise(sandbox.run(
      `const first = await tools.double({ value: 3 })
      const pair = await Promise.all([
        tools.double({ value: first }),
        tools.double({ value: 5 })
      ])
      return pair`,
      {
        tools: {
          double: async (input, ordinal) => {
            const value = (input as { readonly value: number }).value
            observed.push({ ordinal, value })
            return sandboxReturned(value * 2)
          }
        }
      }
    ))

    expect(result).toEqual({ result: [12, 10] })
    expect(observed).toEqual([
      { ordinal: 0, value: 3 },
      { ordinal: 1, value: 6 },
      { ordinal: 2, value: 5 }
    ])
  })

})
