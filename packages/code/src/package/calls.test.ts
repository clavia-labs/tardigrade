import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { eventAt, type Event } from "@clavia/tardigrade-deprecated-core/event"
import { EventLog } from "@clavia/tardigrade-deprecated-core/log"
import { replayProjection } from "@clavia/tardigrade-deprecated-core/projection"
import { machineOf } from "../../../deprecated/core/src/component/runtime"
import type { PackageDefinition } from "./definition"
import { packageCalls } from "./calls"
import { BARE_SPILL_NOTE, hydrate } from "../storage/store"

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

  const called: Event = eventAt({
    type: "PackageCalled", name: "notes.read", arguments: {}, callId: "call-1",
    policy: { call: {}, spill: { spillBytes: 16, previewChars: 4, note: BARE_SPILL_NOTE("call-1") } }
  }, 1)
  const attempt = (value: string) => {
    const [transition] = replayProjection(machineOf(packageCalls({ ...notes, methods: { read: () => Effect.succeed(value) } })), [called]).transitions as unknown as ReadonlyArray<{
      readonly input: unknown
      readonly act: (input: unknown, signal: AbortSignal) => Effect.Effect<ReadonlyArray<Event>, never, KeyValueStore.KeyValueStore>
    }>
    return Effect.map(transition!.act(transition!.input, new AbortController().signal), events => events.find(event => event.type === "PackageReturned")!)
  }

  test("each attempt's pointer reads back its own bytes and names its ref", async () => {
    const [first, second, firstBytes, secondBytes] = await Effect.runPromise(Effect.gen(function* () {
      const first = yield* attempt("a".repeat(64))
      const second = yield* attempt("b".repeat(64))
      return [first, second, yield* hydrate(String(first.tmp)), yield* hydrate(String(second.tmp))] as const
    }).pipe(Effect.provideService(EventLog, {} as never), Effect.provide(KeyValueStore.layerMemory)))
    expect(firstBytes).toBe(JSON.stringify("a".repeat(64)))
    expect(secondBytes).toBe(JSON.stringify("b".repeat(64)))
    expect(first.note).toBe(BARE_SPILL_NOTE(String(first.tmp)))
    expect(second.note).toBe(BARE_SPILL_NOTE(String(second.tmp)))
  })
})
