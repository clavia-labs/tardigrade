import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { eventEpochOf, trajectoryOf, turnEpochOf, turnHead, turnTerminalOf, turnView } from "./turns"

describe("turnHead: message and response events", () => {
  test("an invocation response never heads a turn", () => {
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "agents.run", arguments: {}, turn: "m1", at: 1 },
      { type: "BlockedOn", callId: "c1", turn: "m1", awaiting: "c1.reply", at: 2 },
      { type: "ResponseReceived", id: "c1.reply", status: "completed", output: "4", from: "child", at: 3 }
    ]
    expect(turnHead(log)).toBeUndefined()
  })

  test("a message starts a turn after a package returns", () => {
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "agents.run", arguments: {}, turn: "m1", at: 1 },
      { type: "PackageReturned", callId: "c1", result: { dispatched: true }, turn: "m1", at: 2 },
      { type: "MessageReceived", id: "c1.reply", outcome: "completed", text: "4", from: "child", at: 3 }
    ]
    const head = turnHead(log)
    expect(head).toMatchObject({ id: "c1.reply" })
  })

  test("an ordinary inbound with no matching PackageCalled is unaffected", () => {
    const log: ReadonlyArray<Event> = [{ type: "MessageReceived", id: "m1", text: "hello", at: 1 }]
    expect(turnHead(log)).toMatchObject({ id: "m1" })
  })

  test("a reply-shaped message ID starts a turn", () => {
    const log: ReadonlyArray<Event> = [
      { type: "PackageCalled", callId: "c1", name: "tasks.fire", arguments: {}, turn: "m1", at: 1 },
      { type: "MessageReceived", id: "run-c1.reply", outcome: "completed", text: "done", from: "child", at: 2 }
    ]
    const head = turnHead(log)
    expect(head).toMatchObject({ id: "run-c1.reply" })
  })
})

describe("a resumed turn", () => {
  const failed: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "m1", text: "read", at: 1 },
    { type: "ModelCalled", callId: "m1/infer/0", ordinal: 0, turn: "m1", at: 2 },
    { type: "ToolCalled", callId: "c1", name: "read", arguments: {}, turn: "m1", at: 3 },
    { type: "ToolReturned", callId: "c1", result: "contents", turn: "m1", at: 4 },
    { type: "ModelCalled", callId: "m1/infer/1", ordinal: 1, turn: "m1", at: 5 },
    { type: "TurnFailed", error: "timeout", turn: "m1", at: 6 }
  ]

  test("the retry request opens the next epoch over the committed history", () => {
    const log: ReadonlyArray<Event> = [
      ...failed,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 8 }
    ]

    expect(turnEpochOf(log, "m1")).toBe(1)
    expect(turnHead(log)).toMatchObject({ id: "m1" })
    expect(turnTerminalOf(log, "m1")).toBeUndefined()
    expect(turnView(log).filter((event) => event.type === "ToolReturned")).toHaveLength(1)
    expect(trajectoryOf(log).some((event) => event.type === "TurnFailed")).toBe(false)
  })

  test("the new epoch owns its terminal without redelivering the turn", () => {
    const completed: ReadonlyArray<Event> = [
      ...failed,
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 8 },
      { type: "TurnCompleted", output: "done", turn: "m1", epoch: 1, at: 9 }
    ]

    expect(turnHead(completed)).toBeUndefined()
    expect(turnTerminalOf(completed, "m1")).toMatchObject({ type: "TurnCompleted", output: "done" })
  })

  test("only a failed epoch can resume", () => {
    const cancelled: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m1", text: "read", at: 1 },
      { type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", at: 2 },
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: 3 }
    ]
    expect(turnEpochOf(cancelled, "m1")).toBe(0)
    expect(turnTerminalOf(cancelled, "m1")).toMatchObject({ type: "TurnCancelled" })
    expect(turnHead(cancelled)).toBeUndefined()
  })
})

describe("turn index", () => {
  // thread interleaves completed, failed, resumed, superseded, cancelled, and queued turns with unstamped events.
  const thread = (turns: number): ReadonlyArray<Event> => {
    const log: Event[] = []
    const at = () => log.length + 1
    for (let t = 0; t < turns; t++) {
      const turn = `m${t}`
      log.push({ type: "MessageReceived", id: turn, text: "go", at: at() })
      if (t % 4 === 1) log.push({ type: "MessageReceived", id: `${turn}-queued`, text: "later", at: at() })
      log.push({ type: "ModelCalled", callId: `${turn}/infer/0`, turn, at: at() })
      log.push({ type: "Unstamped", at: at() })
      switch (t % 6) {
        case 0:
          log.push({ type: "TurnCompleted", output: "done", turn, at: at() })
          break
        case 1:
          log.push({ type: "TurnFailed", error: "timeout", turn, at: at() })
          log.push({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 1, at: at() })
          log.push({ type: "TurnCompleted", output: "done", turn, epoch: 1, at: at() })
          break
        case 2:
          log.push({ type: "TurnFailed", error: "timeout", turn, at: at() })
          log.push({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 2, at: at() })
          break
        case 3:
          log.push({ type: "TurnCancelled", request: "x", turn, cause: "requested", at: at() })
          log.push({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 1, at: at() })
          break
        case 4:
          log.push({ type: "TurnFailed", error: "timeout", turn, at: at() })
          log.push({ type: "TurnResumed", turn, failedEpoch: 0, epoch: 1, at: at() })
          log.push({ type: "TurnFailed", error: "again", turn, epoch: 1, at: at() })
          log.push({ type: "TurnResumed", turn, failedEpoch: 1, epoch: 2, at: at() })
          log.push({ type: "TurnCompleted", output: "done", turn, epoch: 2, at: at() })
          break
        default:
          log.push({ type: "TurnResumed", turn, failedEpoch: 3, epoch: 4, at: at() })
          log.push({ type: "TurnCompleted", output: "done", turn, at: at() })
      }
      if (t % 4 === 1) log.push({ type: "TurnCompleted", output: "done", turn: `${turn}-queued`, at: at() })
    }
    return log
  }
  const scannedHead = (log: ReadonlyArray<Event>) =>
    log.find((event) => event.type === "MessageReceived" && turnTerminalOf(log, String(event.id ?? "")) === undefined)
  const terminal = new Set(["TurnCompleted", "TurnFailed", "TurnCancelled"])
  const scannedTrajectory = (log: ReadonlyArray<Event>): ReadonlyArray<Event> => {
    const current = scannedHead(log)
    const emitted = new Set<string>()
    const heads = new Map(log.filter(event => event.type === "MessageReceived").map(event => [String(event.id ?? ""), event]))
    const output: Event[] = []
    for (const event of log) {
      if (event.type === "MessageReceived") continue
      const turn = event.turn === undefined ? undefined : String(event.turn)
      if (turn !== undefined && terminal.has(event.type) && eventEpochOf(event) !== turnEpochOf(log, turn)) continue
      if (turn !== undefined && !emitted.has(turn)) {
        const head = heads.get(turn)
        if (head !== undefined) output.push(head)
        emitted.add(turn)
      }
      output.push(event)
    }
    if (current !== undefined && !emitted.has(String(current.id ?? ""))) output.push(current)
    return output
  }

  test("matches the scanning epoch and head at every prefix", () => {
    const log = thread(24)
    const heads = new Set<unknown>()
    for (let length = 0; length <= log.length; length++) {
      const prefix = log.slice(0, length)
      expect(turnHead(prefix)).toBe(scannedHead(prefix))
      expect(trajectoryOf(prefix)).toEqual(scannedTrajectory(prefix))
      heads.add(turnHead(prefix)?.id)
    }
    expect(heads.size).toBeGreaterThan(24)
  })

  test("head placement and epochs match scanning across reordered histories", () => {
    const event = fc.record({
      type: fc.constantFrom("MessageReceived", "ModelCalled", "TurnFailed", "TurnResumed", "TurnCompleted", "TurnCancelled", "ResponseReceived"),
      id: fc.constantFrom("a", "b", "c"),
      turn: fc.option(fc.constantFrom("a", "b", "c"), { nil: undefined }),
      epoch: fc.option(fc.integer({ min: 0, max: 4 }), { nil: undefined }),
      failedEpoch: fc.option(fc.integer({ min: -1, max: 4 }), { nil: undefined })
    })
    fc.assert(fc.property(fc.array(event, { maxLength: 60 }), log => {
      for (let length = 0; length <= log.length; length++) {
        const prefix = log.slice(0, length)
        expect(turnHead(prefix)).toBe(scannedHead(prefix))
        expect(trajectoryOf(prefix)).toEqual(scannedTrajectory(prefix))
      }
    }), { numRuns: 500 })
  })

  test("trajectory epoch lookups grow linearly with repeated resumes", () => {
    const lookups = (resumes: number): number => {
      const log: Event[] = [{ type: "MessageReceived", id: "m1" }]
      for (let epoch = 0; epoch < resumes; epoch++) {
        log.push({ type: "TurnFailed", turn: "m1", epoch })
        log.push({ type: "TurnResumed", turn: "m1", failedEpoch: epoch, epoch: epoch + 1 })
      }
      const original = Set.prototype.has
      let count = 0
      Set.prototype.has = function (value) {
        if (typeof value === "number") count += 1
        return original.call(this, value)
      }
      let trajectory: ReadonlyArray<Event>
      try {
        trajectory = trajectoryOf(log)
      } finally {
        Set.prototype.has = original
      }
      expect(trajectory).toEqual([log[0]!, ...log.filter(event => event.type === "TurnResumed")])
      return count
    }
    expect(lookups(128)).toBeLessThanOrEqual(2 * lookups(64))
  })
})
