import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import type { MethodResult, WatchdogEntry } from "@clavia/tardigrade-core"
import type { SlowActLog, SlowActOptions } from "../../fixtures/slow-act"
import { waitFor } from "../../fixtures/wait"

export interface LiveInlineFixture {
  readonly start: () => Promise<void>
  readonly result: () => Promise<MethodResult<number> | undefined>
  readonly log: () => Promise<readonly SlowActLog[]>
  readonly watchdog: () => Promise<{ readonly entry: WatchdogEntry | undefined; readonly alarm: number | null }>
  readonly close: () => Promise<void>
}

export const liveInlineExamples = [[{ workMs: 400, value: 42 }]] satisfies [{ workMs: number; value: number }][]

// liveInline checks that real watchdog alarms preserve slow execution in inline and forked placements.
export const liveInline = (createFixture: (options: SlowActOptions) => Promise<LiveInlineFixture>, attemptTimeoutMs: number) => fc.asyncProperty(
  fc.record({ workMs: fc.integer({ min: attemptTimeoutMs * 2, max: attemptTimeoutMs * 6 }), value: fc.integer() }),
  async ({ workMs, value }) => {
    for (const forked of [false, true]) {
      const fixture = await createFixture({ workMs, value, ...(forked ? { fork: { timeoutMs: workMs + 5_000 } } : {}) })
      try {
        await fixture.start()
        await waitFor(fixture.log, log => log.some(entry => entry.kind === "start"))
        const initial = await fixture.watchdog()
        assert.equal(initial.entry?.status, "pending")
        assert.notEqual(initial.alarm, null)
        const observed = await waitFor(async () => ({ result: await fixture.result(), watchdog: await fixture.watchdog() }), state => state.result !== undefined || state.watchdog.entry?.status === "blocked")
        const result = observed.result
        assert.equal(result?.status, "completed", JSON.stringify({ ...observed, log: await fixture.log() }))
        assert.ok(result?.status === "completed" && result.output === value)
        const log = await fixture.log()
        assert.equal(log.filter(entry => entry.kind === "start").length, 1)
        assert.equal(log.filter(entry => entry.kind === "done").length, 1)
        assert.equal(log.filter(entry => entry.kind === "interrupted").length, 0)
        assert.ok(log.find(entry => entry.kind === "done")!.at - log.find(entry => entry.kind === "start")!.at >= workMs)
        const final = await waitFor(fixture.watchdog, state => state.entry === undefined)
        assert.equal(final.alarm, null)
      } finally { await fixture.close() }
    }
  },
)
