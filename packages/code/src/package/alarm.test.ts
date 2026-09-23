import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Alarm, alarmFromLog, alarmSet } from "@clavia/tardigrade-core/alarm"
import { machineOf } from "../../../core/src/component/runtime"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import type { Event } from "@clavia/tardigrade-core/event"
import { alarms } from "./alarm"

describe("alarms package", () => {
  test("set records a durable request and cancel removes it", async () => {
    const events: Event[] = []
    const service = alarmFromLog({
      append: (batch) => Effect.sync(() => { events.push(...batch) }),
      read: Effect.succeed(events),
      head: Effect.sync(() => events.length),
      readFrom: (mark) => Effect.sync(() => events.slice(mark))
    })
    const pkg = alarms()
    const set = await Effect.runPromise(pkg.methods.set!({ wakeAt: 50, note: "Check the job" }, { callId: "call-1" }).pipe(Effect.provideService(Alarm, service)))
    expect(set).toEqual({ id: "alarms/call-1", wakeAt: 50, note: "Check the job" })
    expect(events).toContainEqual(alarmSet("alarms/call-1", 50, "Check the job"))
    const cancel = await Effect.runPromise(pkg.methods.cancel!({ id: "alarms/call-1" }, { callId: "call-2" }).pipe(Effect.provideService(Alarm, service)))
    expect(cancel).toEqual({ id: "alarms/call-1", cancelled: true })
    expect(events).toContainEqual({ type: "AlarmCancelled", id: "alarms/call-1" })
  })

  test("a firing proposes one new agent message and cancellation suppresses it", () => {
    const pkg = alarms()
    const set = alarmSet("alarms/call-1", 50, "Check the job")
    const fired = { type: "AlarmFired", scheduledFor: 50, at: 53 }
    const output = replayProjection(machineOf(pkg), [set, fired])
    const notice = output.transitions.find((work) => work.kind === "intent")
    expect(notice).toBeDefined()
    expect(notice?.events(notice.input, 54)).toContainEqual(expect.objectContaining({
      type: "MessageReceived", id: "alarms/wake/alarms/call-1", text: "Check the job", at: 54
    }))
    expect(replayProjection(machineOf(pkg), [set, fired, ...notice!.events(notice!.input, 54)]).transitions.filter((work) => work.kind === "intent")).toEqual([])
    expect(replayProjection(machineOf(pkg), [set, { type: "AlarmCancelled", id: set.id }, fired]).transitions.filter((work) => work.kind === "intent")).toEqual([])
  })
})
