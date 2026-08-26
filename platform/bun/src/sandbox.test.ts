import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { sandboxReturned, type Bindings } from "@clavia/tardigrade-code/sandbox/service"
import { bunSandboxServiceFor } from "./sandbox"

const run = (
  code: string,
  bindings: Bindings = {},
  policy: Parameters<typeof bunSandboxServiceFor>[0] = {}
) => Effect.runPromise(bunSandboxServiceFor(policy).run(code, bindings, { at: 1_786_900_000_000, seed: "e1" }))

describe("the Bun process sandbox", () => {
  test("returns values and captured logs from an isolated execution", async () => {
    const outcome = await run('console.log("inside"); return { now: Date.now(), random: Math.random() }')
    const replay = await run('return { now: Date.now(), random: Math.random() }')

    expect(outcome.logs).toEqual(["inside"])
    expect(outcome.result).toEqual(replay.result)
    expect(outcome.result).toMatchObject({ now: 1_786_900_000_000 })
  })

  test("bridges concurrent package calls with their invocation ordinals", async () => {
    const seen: number[] = []
    const outcome = await run(
      "return Promise.all([tools.echo('a'), tools.echo('b')])",
      {
        tools: {
          echo: async (value: unknown, ordinal: number) => {
            seen.push(ordinal)
            return sandboxReturned(value)
          }
        }
      }
    )

    expect(outcome.result).toEqual(["a", "b"])
    expect(seen).toEqual([0, 1])
  })

  test("returns rejected package calls to guest code", async () => {
    const outcome = await run(
      "try { await tools.fail() } catch (error) { return String(error) }",
      { tools: { fail: async () => Promise.reject(new Error("package failed")) } }
    )

    expect(outcome.result).toContain("package failed")
  })

  test("keeps a package named fetch available while withholding ambient fetch", async () => {
    const packageOutcome = await run("return await fetch.get({ url: 'x' })", {
      fetch: { get: async () => sandboxReturned("package fetch") }
    })
    const ambientOutcome = await run("return typeof globalThis.fetch")

    expect(packageOutcome.result).toBe("package fetch")
    expect(ambientOutcome.result).toBe("undefined")
  })

  test("discards a detached rejection and keeps later executions healthy", async () => {
    const first = await run('void Promise.reject(new Error("detached guest rejection")); return "settled"')
    const second = await run('return "host alive"')

    expect(first.result).toBe("settled")
    expect(second.result).toBe("host alive")
  })

  test("contains a process exit reached through a constructor escape", async () => {
    const escaped = await run('return await (async function () {}).constructor("process.exit(23)")()')
    const next = await run('return "host alive"')

    expect(escaped.error).toContain("sandbox process exited with code 23")
    expect(next.result).toBe("host alive")
  })

  test("contains a native process abort reached through a constructor escape", async () => {
    let started = false
    const aborted = await run(
      'await probe.ready(); return await (async function () {}).constructor("process.abort()")()',
      {
        probe: {
          ready: async () => {
            started = true
            return sandboxReturned(undefined)
          }
        }
      },
      { segmentTimeoutMs: 250 }
    )
    const next = await run('return "host alive"')

    expect(started).toBe(true)
    expect(aborted.error).toBeDefined()
    expect(next.result).toBe("host alive")
  })

  test("turns malformed child messages into errors", async () => {
    const malformed = await run('return await (async function () {}).constructor("process.send(null)")()')
    const next = await run('return "host alive"')

    expect(malformed.error).toBe("sandbox process sent an invalid message")
    expect(next.result).toBe("host alive")
  })

  test("terminates an uninterrupted execution at the declared limit", async () => {
    const loop = await run("while (true) {}", {}, { segmentTimeoutMs: 25 })
    const next = await run('return "host alive"')

    expect(loop.error).toContain("25 ms execution-segment limit")
    expect(next.result).toBe("host alive")
  })
})
