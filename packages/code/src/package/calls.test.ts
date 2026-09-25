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

// Epoch 0 fails and resumes; a completion stamped with the superseded epoch 0 lands before epoch 1 calls a method.
const resumed: ReadonlyArray<Event> = [
  { type: "MessageReceived", id: "run-1", text: "question" },
  { type: "PackageCalled", name: "notes.read", arguments: { epoch: 0 }, ...stamp(1, 0) },
  { type: "TurnFailed", turn: "run-1" },
  { type: "TurnResumed", turn: "run-1", failedEpoch: 0, epoch: 1 },
  { type: "TurnCompleted", turn: "run-1" },
  { type: "PackageCalled", name: "notes.read", arguments: { epoch: 1 }, ...stamp(2, 1) }
].map((event, index) => eventAt(event, index + 1))

const servedAfter = (events: ReadonlyArray<Event>) => replayProjection(machineOf(packageCalls(notes)), events).view

describe("package calls", () => {
  test("a completion from a superseded epoch keeps the resumed turn current", () => {
    const view = servedAfter(resumed)
    expect(view.calls.map(call => call.arguments)).toEqual([{ epoch: 0 }, { epoch: 1 }])
    expect(view.pendingCalls.map(call => call.arguments)).toEqual([{ epoch: 1 }])
  })

  test("a completion in the active epoch drops the turn", () => {
    const completed = [
      ...resumed,
      { type: "PackageReturned", result: "ok", ...stamp(2, 1) },
      { type: "TurnCompleted", turn: "run-1", epoch: 1 }
    ].map((event, index) => eventAt(event, index + 1))
    const view = servedAfter(completed)
    expect(view.calls).toEqual([])
    expect(view.pendingCalls).toEqual([])
  })
})
