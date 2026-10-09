import { env } from "cloudflare:test"
import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox/service"
import { workerLoaderSandboxServiceFor } from "../src/sandbox"
import type { Env } from "./fixture.worker"

// Long enough that one extra wait dwarfs the per-round worker loads a run pays.
const SLEEP_MS = 400
const SLEEP = `await new Promise((resolve) => setTimeout(resolve, ${SLEEP_MS}));`

// runBody runs `code` on the replay transport, `replayed` leading calls already answered by the log.
const runBody = async (code: string, replayed: number) => {
  const sandbox = workerLoaderSandboxServiceFor((env as Env).LOADER, { transport: "replay" })
  const started = performance.now()
  const outcome = await Effect.runPromise(sandbox.run(
    code,
    { t: { m: async (_input, ordinal) => sandboxReturned(ordinal) } },
    { at: 0, seed: "timers", replayed }
  ))
  return { outcome, elapsedMs: performance.now() - started }
}

// Each replay round re-runs the body from the top; a timer it already waited out must not wait again.
describe("timers in a replayed code body", { timeout: 30_000 }, () => {
  const twoCalls = `${SLEEP} const a = await t.m({}); ${SLEEP} const b = await t.m({}); return [a, b];`

  test("fires every timer set before the calls the log already answered", async () => {
    const run = await runBody(twoCalls, 2)
    expect(run.outcome).toEqual({ result: [0, 1] })
    expect(run.elapsedMs).toBeLessThan(2 * SLEEP_MS)
  })

  test("waits once for each timer a round reaches for the first time", async () => {
    // Round 1 waits before call 0, round 2 skips that wait and waits before call 1, round 3 skips both.
    const run = await runBody(twoCalls, 0)
    expect(run.outcome).toEqual({ result: [0, 1] })
    expect(run.elapsedMs).toBeGreaterThanOrEqual(2 * SLEEP_MS)
    expect(run.elapsedMs).toBeLessThan(3 * SLEEP_MS)
  })

  test("still waits for a timer set after the last answered call", async () => {
    const run = await runBody(`const a = await t.m({}); ${SLEEP} return a;`, 1)
    expect(run.outcome).toEqual({ result: 0 })
    expect(run.elapsedMs).toBeGreaterThanOrEqual(SLEEP_MS)
  })

  test("keeps the full wait of a timer the body awaits only after an answered call", async () => {
    const run = await runBody(`const wait = new Promise((resolve) => setTimeout(resolve, ${SLEEP_MS})); const a = await t.m({}); await wait; return a;`, 1)
    expect(run.outcome).toEqual({ result: 0 })
    expect(run.elapsedMs).toBeGreaterThanOrEqual(SLEEP_MS)
  })

  test("does not fire early a watchdog the body clears after an answered call", async () => {
    const run = await runBody(`let fired = false; const dog = setTimeout(() => { fired = true; }, ${2 * SLEEP_MS}); await t.m({}); await new Promise((resolve) => setTimeout(resolve, 10)); clearTimeout(dog); return fired;`, 1)
    expect(run.outcome).toEqual({ result: false })
  })

  test("keeps an interval and an AbortSignal deadline ahead of a longer timeout", async () => {
    const interval = await runBody(`const winner = await new Promise((resolve) => { let ticks = 0; const every = setInterval(() => { ticks += 1; if (ticks === 3) { clearInterval(every); resolve("interval"); } }, 100); setTimeout(() => resolve("timeout"), ${5 * SLEEP_MS}); }); await t.m({}); return winner;`, 1)
    expect(interval.outcome).toEqual({ result: "interval" })
    expect(interval.elapsedMs).toBeLessThan(SLEEP_MS)
    const deadline = await runBody(`const winner = await new Promise((resolve) => { AbortSignal.timeout(100).addEventListener("abort", () => resolve("abort")); setTimeout(() => resolve("timeout"), ${5 * SLEEP_MS}); }); await t.m({}); return winner;`, 1)
    expect(deadline.outcome).toEqual({ result: "abort" })
    expect(deadline.elapsedMs).toBeLessThan(SLEEP_MS)
  })

  test("rejects a scheduler.wait whose signal aborts", async () => {
    const run = await runBody(`const controller = new AbortController(); setTimeout(() => controller.abort(new Error("stop")), 10); try { await scheduler.wait(${5 * SLEEP_MS}, { signal: controller.signal }); return "waited"; } catch (error) { return error.message; }`, 0)
    expect(run.outcome).toEqual({ result: "stop" })
    expect(run.elapsedMs).toBeLessThan(SLEEP_MS)
  })

  test("keeps replaying timers after a timer callback throws", async () => {
    const run = await runBody(`setTimeout(() => { throw new Error("boom"); }, 100); ${SLEEP} return await t.m({});`, 1)
    expect(run.outcome).toEqual({ result: 0 })
    expect(run.elapsedMs).toBeLessThan(SLEEP_MS)
  })

  test("calls a timer callback with the worker global as its receiver", async () => {
    const run = await runBody("return await new Promise((resolve) => setTimeout(function () { resolve(this === globalThis); }, 0));", 0)
    expect(run.outcome).toEqual({ result: true })
  })
})
