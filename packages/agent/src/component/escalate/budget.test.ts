import { testMachineOf as machineOf } from "../../../fixtures/component"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { replayState } from "@clavia/tardigrade-core/projection"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Transition } from "@clavia/tardigrade-core/runtime"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { linkOf } from "@clavia/tardigrade-core/transport/link"
import { tool } from "../tool/index"
import { budget } from "../budget/index"
import { escalate, caller, DEFAULT_ESCALATION_TOOL } from "./index"

const head: Event = {
  type: "MessageReceived",
  id: "turn",
  text: "work",
  escalatable: true,
  at: 0,
  link: linkOf(threadAddressOf("agent", "main", "parent"), threadAddressOf("agent", "main", "child"))
}
const eventsOf = (transitions: ReadonlyArray<Transition<never, unknown>>) =>
  transitions.flatMap((transition) => (transition.kind === "intent" ? transition.events(transition.input, 1) : []))
const createBudget = () =>
  budget(
    tool({
      spec: { name: "read", description: "Read", inputSchema: { type: "object" } },
      run: () => Effect.succeed("read")
    }),
    {
      limit: 1,
      usage: (observation) => observation.calls.length,
      onExhausted: (reason, settle) => settle({ error: reason })
    }
  )
const call = (callId: string, name = "read"): Event => ({
  type: "ToolCalled",
  callId,
  name,
  arguments: { reason: "more work", amount: 2 },
  turn: "turn",
  at: 2
})

test("escalation eligibility and rendering options control the offered request", () => {
  const child = createBudget()
  const parent = escalate(child, {
    authority: caller(),
    tool: { ...DEFAULT_ESCALATION_TOOL, name: "ask_more" },
    exhaustedMessage: "Allowance spent.",
    requestMessage: "Use ask_more to request an increase."
  })
  const wall: Event = { type: "BudgetExhausted", budget: 1, used: 2, turn: "turn", at: 1 }
  const render = (log: ReadonlyArray<Event>) => machineOf(parent).output(replayState(machineOf(parent), log)).view
  expect(render([head]).tools.map((tool) => tool.spec.name)).toEqual(["read"])
  expect(render([{ ...head, escalatable: false }, wall]).tools).toEqual([])
  expect(render([{ ...head, link: undefined }, wall]).tools).toEqual([])
  const view = render([head, wall])
  expect(view.tools.map((tool) => tool.spec.name)).toEqual(["ask_more"])
  expect(view.system).toEqual(expect.arrayContaining(["Allowance spent.", "Use ask_more to request an increase."]))
  const output = machineOf(parent).output(replayState(machineOf(parent), [head, wall, call("ask", "ask_more")]))
  expect(eventsOf(output.transitions)).toContainEqual(
    expect.objectContaining({ type: "BudgetRequested", callId: "tool/3" })
  )
})
