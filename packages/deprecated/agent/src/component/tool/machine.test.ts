import { expect, test } from "bun:test"
import { HashMap } from "effect"
import { component } from "@clavia/tardigrade-deprecated-core/actor"
import { eventAt, type Event } from "@clavia/tardigrade-deprecated-core/event"
import { replayState } from "@clavia/tardigrade-deprecated-core/projection"
import { machineOf } from "../../../../core/src/component/runtime"
import type { ToolOffer } from "../view"
import { AGENT_VIEW_ALGEBRA } from "../infer/index"
import { toolComponent } from "./machine"

const offer: ToolOffer = {
  spec: { name: "read", description: "read", inputSchema: {} },
  serve: (_call, _log, answer) => [answer("contents")]
}

// offering counts its own output derivations and changes state on every event, as a live child does.
const offering = (reads: { count: number }) => toolComponent(component({
  name: "offering",
  initial: () => 0,
  step: (seen) => seen + 1,
  output: () => {
    reads.count++
    return { transitions: [], view: { ...AGENT_VIEW_ALGEBRA.empty, tools: [{ spec: offer.spec }] }, interactions: { tools: () => [offer] } }
  }
}))

const turn = (id: string, call: string, terminal?: string): ReadonlyArray<Event> => [
  { type: "MessageReceived", id, text: "go", budget: 1, at: 0 },
  { type: "ModelCalled", callId: `model-${id}`, turn: id, at: 0 },
  { type: "ToolCalled", callId: call, name: "read", arguments: {}, turn: id, at: 0 },
  ...(terminal === undefined ? [] : [{ type: terminal, turn: id, output: "", at: 0 }])
]

const log = [
  ...turn("t1", "a", "TurnCompleted"),
  ...turn("t2", "b", "TurnCancelled"),
  ...turn("t3", "c", "TurnFailed"),
  ...turn("t4", "d")
]

interface ToolsSnapshot {
  readonly state: {
    readonly own: {
      readonly offers: HashMap.HashMap<string, unknown>
      readonly known: HashMap.HashMap<number, { readonly call: { readonly turn?: string } }>
      readonly pending: HashMap.HashMap<number, { readonly call: { readonly callId: string } }>
    }
  }
}

test("a settled turn leaves no stored offer, and a closed turn no known calls", () => {
  const machine = machineOf(offering({ count: 0 }))
  const own = (replayState(machine, log) as ToolsSnapshot).state.own

  expect([...HashMap.keys(own.offers)]).toEqual(["t4"])
  // A failed turn can resume, so its calls stay known until it completes or is cancelled.
  expect([...HashMap.values(own.known)].map((entry) => entry.call.turn).sort()).toEqual(["t3", "t4"])
  expect([...HashMap.values(own.pending)].map((record) => record.call.callId)).toEqual(["d"])
})

test("cold replay derives no child output until the output is read, and the output is unchanged", () => {
  const reads = { count: 0 }
  const machine = machineOf(offering(reads))
  const state = replayState(machine, log)

  expect(reads.count).toBe(0)
  const output = machine.output(state)
  expect(output.view.pendingCalls.map((call) => call.callId)).toEqual(["d"])
  expect(output.view.calls.map((call) => call.callId)).toEqual(["d"])
  expect(output.transitions.flatMap((work) => work.kind === "intent" ? work.events(work.input, 1) : []))
    .toEqual([expect.objectContaining({ type: "ToolReturned", callId: "d", result: "contents" })])
})

test("an offer read during a live settle resolves at once and matches a cold replay", () => {
  const reads = { count: 0 }
  const machine = machineOf(offering(reads))
  let state = machine.initial()
  for (const [index, event] of log.entries()) {
    state = machine.step(state, eventAt(event, index + 1))
    machine.output(state)
  }

  // One derivation per reached child state: resolving an offer reuses the read output.
  expect(reads.count).toBe(log.length)
  expect(machine.output(state).view).toEqual(machine.output(replayState(machine, log)).view)
})
