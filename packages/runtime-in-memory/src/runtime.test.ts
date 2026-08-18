import { describe, expect, test } from "bun:test"
import { Clock, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import {
  Alarm,
  EventLog,
  Router,
  Self,
  Sessions,
  Writer,
  actor,
  conformance,
  dedupKey,
  machine,
  send,
  type DedupKey,
  type Event
} from "@flamecast/core"
import { InMemoryRuntime, type InMemoryOptions, type SessionPorts } from "./runtime"

// The runtime owes the published ports and six log guarantees. These tests read each guarantee back
// through the port, because a runtime is trusted for what the core can observe through the seam.

const ev = (type: string): Event => ({ type })

// The runtime requires a key policy rather than assuming one. These tests run under the core's
// own, where an event states its own key, and the file says so once here.
const inRuntime = <A, const Keys = Readonly<Record<string, never>>>(
  program: Effect.Effect<A, never, SessionPorts>,
  {
    keyOf = dedupKey,
    ...options
  }: Omit<InMemoryOptions<never, Keys>, "keyOf"> & { readonly keyOf?: DedupKey } = {}
) =>
  Effect.runPromise(
    Effect.provide(program, InMemoryRuntime({ ...options, keyOf } as InMemoryOptions<never, Keys>))
  )

describe("the event log", () => {
  test("guarantee 1 and 2: an append binds, and seq rises and never repeats", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("A")])
        const first = yield* log.head
        yield* log.append([ev("B")])
        const second = yield* log.head
        return { first, second, events: (yield* log.read).map((e) => e.type) }
      })
    )
    expect(result.first).toBe(1)
    expect(result.second).toBe(2)
    expect(result.events).toEqual(["A", "B"])
  })

  test("guarantee 4: a batch commits as one unit, in the order it was given", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("A"), ev("B"), ev("C")])
        return (yield* log.read).map((e) => e.type)
      })
    )
    expect(events).toEqual(["A", "B", "C"])
  })

  test("guarantee 5: a redelivered key is absorbed, across batches and inside one", async () => {
    const message: Event = { type: "MessageReceived", key: "msg:m-1" }
    const result = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([message])
        yield* log.append([message])
        yield* log.append([message, message, ev("Mark")])
        return (yield* log.read).map((e) => e.type)
      })
    )
    expect(result).toEqual(["MessageReceived", "Mark"])
  })

  test("guarantee 5: an event with no key always lands, so a repeated mark stays as evidence", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("Mark"), ev("Mark"), ev("Mark")])
        return yield* log.read
      })
    )
    expect(events).toHaveLength(3)
  })

  test("guarantee 6: readFrom returns the tail after the watermark", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("A"), ev("B")])
        const mark = yield* log.head
        yield* log.append([ev("C")])
        return {
          tail: (yield* log.readFrom(mark)).map((e) => e.type),
          whole: (yield* log.readFrom(0)).map((e) => e.type),
          empty: yield* log.readFrom(yield* log.head)
        }
      })
    )
    expect(result.tail).toEqual(["C"])
    expect(result.whole).toEqual(["A", "B", "C"])
    expect(result.empty).toEqual([])
  })

  test("an absorbed batch does not move the watermark", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        const message: Event = { type: "MessageReceived", key: "msg:m-1" }
        yield* log.append([message])
        const before = yield* log.head
        yield* log.append([message])
        return { before, after: yield* log.head }
      })
    )
    expect(result.after).toBe(result.before)
  })

  test("a seed starts the log from a recorded one", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        return (yield* log.read).map((e) => e.type)
      }),
      { seed: [ev("Asked"), ev("Answered")] }
    )
    expect(events).toEqual(["Asked", "Answered"])
  })

  test("a read hands out history, never the storage behind it", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("A")])
        const first = yield* log.read
        ;(first as Array<Event>).push(ev("Forged"))
        return (yield* log.read).map((e) => e.type)
      })
    )
    expect(events).toEqual(["A"])
  })

  test("the key policy the caller passes is the one the store absorbs on", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([{ type: "ToolReturned", callId: "c-1" }])
        yield* log.append([{ type: "ToolReturned", callId: "c-1" }])
        yield* log.append([{ type: "ToolReturned", callId: "c-2" }])
        return (yield* log.read).map((e) => e.callId)
      }),
      { keyOf: (event) => (event.type === "ToolReturned" ? `tr:${String(event.callId)}` : undefined) }
    )
    expect(events).toEqual(["c-1", "c-2"])
  })
})

describe("the writer", () => {
  test("guarantee 3: one writer per session, so two turns can not interleave", async () => {
    const trace: Array<string> = []
    const work = (name: string) =>
      Effect.gen(function* () {
        trace.push(`${name}:in`)
        yield* Effect.yieldNow
        trace.push(`${name}:out`)
      })

    await inRuntime(
      Effect.gen(function* () {
        const writer = yield* Writer
        const first = yield* Effect.forkChild(writer.hold("user-42", work("a")))
        const second = yield* Effect.forkChild(writer.hold("user-42", work("b")))
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      })
    )
    expect(trace).toEqual(["a:in", "a:out", "b:in", "b:out"])
  })

  test("two sessions hold two leases, so one session never blocks another", async () => {
    const trace: Array<string> = []
    const work = (name: string) =>
      Effect.gen(function* () {
        trace.push(`${name}:in`)
        yield* Effect.yieldNow
        trace.push(`${name}:out`)
      })

    await inRuntime(
      Effect.gen(function* () {
        const writer = yield* Writer
        const first = yield* Effect.forkChild(writer.hold("user-1", work("a")))
        const second = yield* Effect.forkChild(writer.hold("user-2", work("b")))
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      })
    )
    expect(trace).toEqual(["a:in", "b:in", "a:out", "b:out"])
  })

  test("the lease carries the services and the errors of the work it holds", async () => {
    const held = await inRuntime(
      Effect.gen(function* () {
        const writer = yield* Writer
        return yield* writer.hold(
          "user-42",
          Effect.gen(function* () {
            const log = yield* EventLog
            yield* log.append([ev("Inside")])
            return (yield* log.read).length
          })
        )
      })
    )
    expect(held).toBe(1)
  })
})

describe("routing and sessions", () => {
  test("an address no session serves answers, rather than hanging or dying", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        return yield* (yield* Router).call("ag/other", { type: "MessageReceived", id: "m-1" })
      })
    )
    expect(result.type).toBe("TurnFailed")
    expect(String(result.error)).toContain('no session serves "ag/other"')
  })

  test("the router carries an event out and an event back", async () => {
    const seen: Array<string> = []
    const result = await inRuntime(
      Effect.gen(function* () {
        const router = yield* Router
        yield* router.deliver("ag/child", ev("Ping"))
        return yield* router.call("ag/child", ev("Ask"))
      }),
      {
        sessions: {
          "ag/*": (address: string) => (event: Event) => {
            seen.push(`${address}:${event.type}`)
            return Effect.succeed({ type: "TurnCompleted", output: "done" })
          }
        }
      }
    )
    expect(seen).toEqual(["ag/child:Ping", "ag/child:Ask"])
    expect(result.type).toBe("TurnCompleted")
  })

  test("a served session gets its own log and its own name", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        return yield* (yield* Router).call("ag/child", ev("Ask"))
      }),
      {
        sessions: {
          "ag/*": () =>
            Effect.fn(function* (event: Event) {
              const store = yield* EventLog
              yield* store.append([event])
              const rows = yield* store.read
              return { type: "TurnCompleted", output: `${yield* Self}:${rows.length}` }
            })
        }
      }
    )
    // Its own store, so the parent's seeded log is not what it counted, and its own `Self`.
    expect(result.output).toBe("ag/child:1")
  })

  test("sessions lists what the runtime serves and reads one session's log", async () => {
    const listed = await inRuntime(
      Effect.gen(function* () {
        yield* (yield* Router).deliver("ag/one", ev("Ping"))
        const sessions = yield* Sessions
        return { list: yield* sessions.list, rows: yield* sessions.read("ag/one") }
      }),
      {
        sessions: {
          "ag/*": () =>
            Effect.fn(function* (event: Event) {
              yield* (yield* EventLog).append([event])
              return { type: "TurnCompleted", output: "ok" }
            })
        }
      }
    )
    expect(listed.list).toContain("ag/one")
    expect(listed.rows.map((row) => row.type)).toEqual(["Ping"])
  })
})

describe("machines over the runtime", () => {
  const answering = machine({
    id: "answering",
    initial: "idle",
    states: {
      idle: { on: { Asked: "answering" } },
      answering: {
        decide: (_log, now) => [{ type: "Answered", at: now }],
        on: { Answered: "idle" }
      }
    }
  })

  test("a send appends and settles to quiescence", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        yield* send(actor([answering]), ev("Asked"))
        return (yield* (yield* EventLog).read).map((e) => e.type)
      })
    )
    expect(events).toEqual(["Asked", "Answered"])
  })

  test("an act reads time through the Clock, so a test controls it", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        yield* send(actor([answering]), ev("Asked"))
        return yield* (yield* EventLog).read
      })
    )
    expect(typeof events[1]?.at).toBe("number")
  })

  // The conformance kit is what a runtime is judged by. Run inside the layer it also probes the
  // store, which is the half a machine-only report can not reach.
  test("the conformance kit passes against this runtime, store probe included", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        const report = yield* conformance({
          machines: [answering],
          logs: [[ev("Asked"), ev("Answered")]],
          keyOf: dedupKey
        })
        return { report, log: (yield* (yield* EventLog).read).map((e) => e.type) }
      })
    )
    expect(result.report.ok).toBe(true)
    // The probe appends one keyed event twice, and the store absorbs the second copy.
    expect(result.log).toEqual(["ConformanceProbe"])
  })

  test("the kit reports a store that lets a redelivered event land twice", async () => {
    const report = await Effect.runPromise(
      Effect.provide(
        conformance({ machines: [answering], logs: [], keyOf: dedupKey }),
        // A store that derives no key from anything absorbs nothing, which is the failure the kit
        // exists to name.
        InMemoryRuntime({ keyOf: () => undefined })
      )
    )
    expect(report.dedup.ok).toBe(false)
    expect(report.dedup.failures).toEqual([
      'the store appended a redelivered event twice for the key "flamecast/conformance/dedup-probe"',
      "the store returned 2 copies of one redelivered event from its watermark"
    ])
  })
})

describe("the alarm", () => {
  test("delivers the wake event to a served session after the due time", async () => {
    const seen: Array<string> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Alarm).set("ag/child", (yield* Clock.currentTimeMillis) + 60_000, ev("Woke"))
        yield* TestClock.adjust("1 minute")
        yield* Effect.yieldNow
      }).pipe(
        Effect.provide(
          Layer.merge(
            InMemoryRuntime({
              keyOf: dedupKey,
              sessions: {
                "ag/*": () => (event: Event) => {
                  seen.push(event.type)
                  return Effect.succeed({ type: "TurnCompleted" })
                }
              }
            }),
            TestClock.layer()
          )
        )
      )
    )
    expect(seen).toEqual(["Woke"])
  })

  test("a later set replaces the earlier arm", async () => {
    const seen: Array<string> = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const alarm = yield* Alarm
        const now = yield* Clock.currentTimeMillis
        yield* alarm.set("ag/child", now + 60_000, ev("First"))
        yield* alarm.set("ag/child", now + 120_000, ev("Second"))
        yield* TestClock.adjust("1 minute")
        yield* Effect.yieldNow
        expect(seen).toEqual([])
        yield* TestClock.adjust("1 minute")
        yield* Effect.yieldNow
      }).pipe(
        Effect.provide(
          Layer.merge(
            InMemoryRuntime({
              keyOf: dedupKey,
              sessions: {
                "ag/*": () => (event: Event) => {
                  seen.push(event.type)
                  return Effect.succeed({ type: "TurnCompleted" })
                }
              }
            }),
            TestClock.layer()
          )
        )
      )
    )
    expect(seen).toEqual(["Second"])
  })
})
