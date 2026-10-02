import { Context, Effect } from "effect"
import type { Event } from "./event"
import type { EventLog } from "./log"

export interface AlarmSet extends Event {
  readonly type: "AlarmSet"
  readonly id: string
  readonly wakeAt: number
  readonly note?: string
}

// alarmSet records a named wake in the thread log.
export const alarmSet = (id: string, wakeAt: number, note?: string): AlarmSet => {
  if (id.length === 0) throw new Error("alarm id must not be empty")
  if (!Number.isSafeInteger(wakeAt) || wakeAt < 0) throw new Error("alarm wakeAt must be a non-negative safe integer")
  if (note !== undefined && typeof note !== "string") throw new Error("alarm note must be a string")
  return { type: "AlarmSet", id, wakeAt, ...(note === undefined ? {} : { note }) }
}

export interface AlarmCancelled extends Event {
  readonly type: "AlarmCancelled"
  readonly id: string
}

// alarmCancelled removes a named wake from host scheduling.
export const alarmCancelled = (id: string): AlarmCancelled => {
  if (id.length === 0) throw new Error("alarm id must not be empty")
  return { type: "AlarmCancelled", id }
}

// alarmEventKeyOf gives each wake request and cancellation a stable storage key across effect replay (alarm.test.ts, "replayed set does not rearm a completed request").
export const alarmEventKeyOf = (event: Event): string | undefined =>
  typeof event.id !== "string" ? undefined
    : event.type === "AlarmSet" ? `alarm-set:${JSON.stringify(event.id)}`
      : event.type === "AlarmCancelled" ? `alarm-cancelled:${JSON.stringify(event.id)}` : undefined

// pendingAlarmsOf projects requests that have neither rung nor been cancelled.
export const pendingAlarmsOf = (log: ReadonlyArray<Event>): ReadonlyMap<string, AlarmSet> => {
  const pending = new Map<string, AlarmSet>()
  for (const event of log) {
    if (event.type === "AlarmSet" && typeof event.id === "string" &&
      typeof event.wakeAt === "number" && Number.isSafeInteger(event.wakeAt) && event.wakeAt >= 0) {
      pending.set(event.id, event as AlarmSet)
    } else if (event.type === "AlarmCancelled" && typeof event.id === "string") {
      pending.delete(event.id)
    } else if (event.type === "AlarmFired" && typeof event.at === "number") {
      for (const [id, request] of pending) if (request.wakeAt <= event.at) pending.delete(id)
    }
  }
  return pending
}

// nextAlarmOf projects the earliest outstanding wake from AlarmSet, AlarmCancelled, and AlarmFired events.
export const nextAlarmOf = (log: ReadonlyArray<Event>): number | undefined => {
  let earliest: number | undefined
  for (const request of pendingAlarmsOf(log).values()) earliest = earliest === undefined ? request.wakeAt : Math.min(earliest, request.wakeAt)
  return earliest
}

// Alarm records durable wake requests in the thread log; the host owns the physical alarm slot.
export class Alarm extends Context.Service<
  Alarm,
  {
    readonly set: (id: string, wakeAt: number, note?: string) => Effect.Effect<void>
    readonly cancel: (id: string) => Effect.Effect<boolean>
  }
>()("tardigrade/Alarm") {
  // set records a named wake for host scheduling. An id names one intended wake and must not be reused for another time.
  static set(id: string, wakeAt: number, note?: string): Effect.Effect<void, never, Alarm> {
    return Effect.flatMap(Alarm, (alarm) => alarm.set(id, wakeAt, note))
  }

  // cancel records removal of an outstanding wake and reports whether it was pending.
  static cancel(id: string): Effect.Effect<boolean, never, Alarm> {
    return Effect.flatMap(Alarm, (alarm) => alarm.cancel(id))
  }
}

// alarmFromLog binds Alarm to a thread's event log.
export const alarmFromLog = (log: typeof EventLog.Service): typeof Alarm.Service => ({
  set: (id, wakeAt, note) => Effect.gen(function* () {
    const request = alarmSet(id, wakeAt, note)
    const history = yield* log.read
    const existing = history.find((event) => event.type === "AlarmSet" && event.id === id)
    if (existing !== undefined) {
      if (existing.wakeAt !== wakeAt || existing.note !== note) {
        return yield* Effect.die(new Error(`alarm ${JSON.stringify(id)} already has another request`))
      }
      return
    }
    yield* log.append([request])
  }),
  cancel: (id) => Effect.gen(function* () {
    const cancellation = alarmCancelled(id)
    const history = yield* log.read
    if (!pendingAlarmsOf(history).has(id)) return false
    yield* log.append([cancellation])
    return true
  })
})
