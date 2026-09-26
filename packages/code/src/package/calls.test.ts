import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { machineOf } from "../../../core/src/component/runtime"
import type { PackageDefinition } from "./definition"
import { packageCalls } from "./calls"

const notes: PackageDefinition<never> = {
  name: "notes",
  description: "Notes",
  methods: { read: () => Effect.succeed("ok") }
}

const ref = (seq: number) => ({ seq, component: "code.dispatch", tag: "dispatch" })
const stamp = (seq: number, epoch: number) => ({ callId: `exec-${seq}.0`, executionRef: ref(seq), ordinal: 0, turn: "run-1", ...(epoch === 0 ? {} : { epoch }) })

const resumed = (terminal: "TurnCompleted" | "TurnCancelled", order: "before" | "after"): ReadonlyArray<Event> => {
  const completion: Event = { type: terminal, turn: "run-1" }
  const resume: Event = { type: "TurnResumed", turn: "run-1", failedEpoch: 0, epoch: 1 }
  return [
    { type: "MessageReceived", id: "run-1", text: "question" },
    { type: "PackageCalled", name: "notes.read", arguments: { epoch: 0 }, ...stamp(1, 0) },
    { type: "TurnFailed", turn: "run-1" },
    ...(order === "before" ? [completion, resume] : [resume, completion]),
    { type: "PackageCalled", name: "notes.read", arguments: { epoch: 1 }, ...stamp(2, 1) }
  ].map((event, index) => eventAt(event, index + 1))
}

const servedAfter = (events: ReadonlyArray<Event>) => replayProjection(machineOf(packageCalls(notes)), events).view

describe("package calls", () => {
  test.each([
    ["TurnCompleted", "before"],
    ["TurnCompleted", "after"],
    ["TurnCancelled", "before"],
    ["TurnCancelled", "after"]
  ] as const)("a late %s %s resume preserves the turn's calls", (terminal, order) => {
    const view = servedAfter(resumed(terminal, order))
    expect(view.calls.map(call => call.arguments)).toEqual([{ epoch: 0 }, { epoch: 1 }])
    expect(view.pendingCalls.map(call => call.arguments)).toEqual([{ epoch: 1 }])
  })

  test.each(["TurnCompleted", "TurnCancelled"] as const)("%s in the active epoch drops the turn", (terminal) => {
    const completed = [
      ...resumed(terminal, "after"),
      { type: "PackageReturned", result: "ok", ...stamp(2, 1) },
      { type: terminal, turn: "run-1", epoch: 1 }
    ].map((event, index) => eventAt(event, index + 1))
    const view = servedAfter(completed)
    expect(view.calls).toEqual([])
    expect(view.pendingCalls).toEqual([])
  })
})
