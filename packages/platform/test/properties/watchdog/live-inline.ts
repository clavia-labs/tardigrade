import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import type { MethodResult, WatchdogEntry } from "@clavia/tardigrade-core"
import type { SlowActLog, SlowActOptions } from "../../fixtures/slow-act"
import { waitFor } from "../../fixtures/wait"

export interface LiveInlineFixture {
  readonly start: () => Promise<void>
  readonly result: () => Promise<MethodResult<number> | undefined>
  readonly log: () => Promise<readonly SlowActLog[]>
  readonly crash: () => Promise<void>
  readonly watchdog: () => Promise<{ readonly entry: WatchdogEntry | undefined; readonly alarm: number | null }>
  readonly close: () => Promise<void>
}

export const liveInlineExamples = [[{ workMs: 400, value: 42, restart: false }], [{ workMs: 400, value: 42, restart: true }]] satisfies [{ workMs: number; value: number; restart: boolean }][]

// liveInline checks that real watchdog alarms preserve slow execution in inline and forked placements, including after loss of the live runtime.
export const liveInline = (createFixture: (options: SlowActOptions) => Promise<LiveInlineFixture>, attemptTimeoutMs: number) => fc.asyncProperty(
  fc.record({ workMs: fc.integer({ min: attemptTimeoutMs * 2, max: attemptTimeoutMs * 6 }), value: fc.integer(), restart: fc.boolean() }),
  async ({ workMs, value, restart }) => {
    for (const forked of [false, true]) {
      const fixture = await createFixture({ workMs, value, ...(forked ? { fork: { timeoutMs: workMs + 5_000 } } : {}) })
      try {
        await fixture.start()
        await waitFor(fixture.log, log => log.some(entry => entry.kind === "start"))
        const initial = await fixture.watchdog()
        assert.equal(initial.entry?.status, "pending")
        assert.notEqual(initial.alarm, null)
        if (restart) {
          await fixture.crash()
          // log observations must leave the thread cold so its durable alarm owns recovery.
          const recovered = await waitFor(fixture.log, log => {
            const replay = log.findIndex((entry, index) => index > 0 && entry.kind === "start")
            return log.some(entry => entry.kind === "done") || (replay >= 0 && log.slice(replay).some(entry => entry.kind === "interrupted"))
          })
          const replay = recovered.findIndex((entry, index) => index > 0 && entry.kind === "start")
          assert.ok(replay >= 0, JSON.stringify(recovered))
          assert.equal(recovered.slice(replay).filter(entry => entry.kind === "interrupted").length, 0, JSON.stringify(recovered))
        }
        const observed = await waitFor(async () => ({ result: await fixture.result(), watchdog: await fixture.watchdog() }), state => state.result !== undefined || state.watchdog.entry?.status === "blocked")
        const result = observed.result
        assert.equal(result?.status, "completed", JSON.stringify({ ...observed, log: await fixture.log() }))
        assert.ok(result?.status === "completed" && result.output === value)
        const log = await fixture.log()
        assert.equal(log.filter(entry => entry.kind === "start").length, restart ? 2 : 1)
        assert.equal(log.filter(entry => entry.kind === "done").length, 1)
        const execution = restart ? log.slice(log.findIndex((entry, index) => index > 0 && entry.kind === "start")) : log
        assert.equal(execution.filter(entry => entry.kind === "interrupted").length, 0)
        assert.ok(execution.find(entry => entry.kind === "done")!.at - execution.find(entry => entry.kind === "start")!.at >= workMs)
        const final = await waitFor(fixture.watchdog, state => state.entry === undefined)
        assert.equal(final.alarm, null)
      } finally { await fixture.close() }
    }
  },
)
