import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import {
  EventLog,
  Placement,
  Router,
  Self,
  Sink,
  Spill,
  Wake,
  Writer,
  actor,
  conformance,
  dedupKey,
  machine,
  send,
  type DedupKey,
  type Event
} from "@flamecast/core"
import { InMemoryRuntime, type InMemoryOptions } from "./runtime"

// The runtime owes eight ports and six log guarantees. These tests read each guarantee back through
// the port, because a runtime is trusted for what the core can observe through the seam.

const ev = (type: string): Event => ({ type })

// The runtime requires a key policy rather than assuming one. These tests run under the core's
// own, where an event states its own key, and the file says so once here.
const inRuntime = <A>(
  program: Effect.Effect<A, never, EventLog | Writer | Wake | Placement | Spill | Sink | Router | Self>,
  { keyOf = dedupKey, ...options }: Omit<InMemoryOptions, "keyOf"> & { readonly keyOf?: DedupKey } = {}
) => Effect.runPromise(Effect.provide(program, InMemoryRuntime({ ...options, keyOf })))

const died = async (program: Effect.Effect<unknown, never, never>) => {
  const exit = await Effect.runPromiseExit(program)
  return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "the program did not die"
}

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

describe("the other ports", () => {
  test("wake keeps the nearest alarm and lists what is owed", async () => {
    const owed = await inRuntime(
      Effect.gen(function* () {
        const wake = yield* Wake
        yield* wake.armIfSooner(5_000)
        yield* wake.armIfSooner(9_000)
        yield* wake.armIfSooner(1_000)
        return yield* wake.owed
      }),
      { session: "user-42" }
    )
    expect(owed).toEqual([{ session: "user-42", at: 1_000 }])
  })

  test("wake owes nothing until something arms it", async () => {
    expect(await inRuntime(Effect.gen(function* () { return yield* (yield* Wake).owed }))).toEqual([])
  })

  test("placement sends every address to the one host, and Self carries the session", async () => {
    const result = await inRuntime(
      Effect.gen(function* () {
        const placement = yield* Placement
        return { home: yield* placement.home("anything"), self: yield* Self }
      }),
      { session: "user-42" }
    )
    expect(result).toEqual({ home: "user-42", self: "user-42" })
  })

  test("spill round trips a value the log is too small to hold", async () => {
    const value = new TextEncoder().encode("a tool result too large for one event")
    const result = await inRuntime(
      Effect.gen(function* () {
        const spill = yield* Spill
        const ref = yield* spill.put(value)
        return { ref, read: yield* spill.get(ref) }
      })
    )
    expect(result.ref).toBe("spill:1")
    expect(new TextDecoder().decode(result.read)).toBe("a tool result too large for one event")
  })

  test("spill dies on a reference it never wrote", async () => {
    const message = await died(
      Effect.provide(
        Effect.gen(function* () {
          return yield* (yield* Spill).get("spill:404")
        }),
        InMemoryRuntime({ keyOf: dedupKey })
      )
    )
    expect(message).toContain('no spilled value at "spill:404"')
  })

  test("the sink drops what it is given, and the log stays complete", async () => {
    const events = await inRuntime(
      Effect.gen(function* () {
        const log = yield* EventLog
        yield* log.append([ev("Asked")])
        yield* (yield* Sink).write([{ type: "Asked", session: "user-42" }])
        return yield* log.read
      })
    )
    expect(events).toHaveLength(1)
  })

  test("the router dies on an address it has no route to", async () => {
    const message = await died(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Router).deliver("ag/other", ev("Ping"))
        }),
        InMemoryRuntime({ keyOf: dedupKey })
      )
    )
    expect(message).toContain('no route to "ag/other" for "Ping"')
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
        route: (address, event) => {
          seen.push(`${address}:${event.type}`)
          return Effect.succeed({ type: "TurnCompleted", output: "done" })
        }
      }
    )
    expect(seen).toEqual(["ag/child:Ping", "ag/child:Ask"])
    expect(result.type).toBe("TurnCompleted")
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
