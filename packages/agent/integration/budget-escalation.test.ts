import { testMachineOf as machineOf } from "../fixtures/component"
import { eventAt } from "@clavia/tardigrade-core/event"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { replayState } from "@clavia/tardigrade-core/projection"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Transition } from "@clavia/tardigrade-core/runtime"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { linkOf } from "@clavia/tardigrade-core/transport/link"
import { tool } from "../src/component/tool/index"
import { budget } from "../src/component/budget/index"
import { escalate, caller } from "../src/component/escalate/index"

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

for (const decision of ["grant", "deny"] as const) {
  test(`escalation settles ${decision} after replay without charging the request`, () => {
    const child = createBudget()
    const parent = escalate(child, { authority: caller() })
    const prefix = [
      head,
      call("first"),
      { type: "ToolReturned", transitionRef: { seq: 2, component: "tools", tag: "answer" }, callId: "first", result: "ok", turn: "turn" },
      call("over")
    ]
    const wallState = replayState(machineOf(parent), prefix)
    const wallEvents = eventsOf(machineOf(parent).output(wallState).transitions)
    expect(wallEvents).toContainEqual(
      expect.objectContaining({ type: "ToolReturned", callId: "over", result: { error: "Budget exhausted." } })
    )
    expect(wallEvents).toContainEqual(expect.objectContaining({ type: "BudgetExhausted" }))
    const atWall = [...prefix, ...wallEvents]
    const exhausted = replayState(machineOf(parent), atWall)
    expect(
      machineOf(parent)
        .output(exhausted)
        .view.tools.map((tool) => tool.spec.name)
    ).toEqual(["request_budget"])
    expect(machineOf(parent).output(exhausted).view).toMatchObject({ phase: "exhausted", used: 2 })
    const requested = [...atWall, call("ask", "request_budget")]
    const requestEvents = eventsOf(
      machineOf(parent).output(replayState(machineOf(parent), requested)).transitions
    ).filter((event) => event.type === "BudgetRequested")
    expect(requestEvents).toHaveLength(1)
    const pending = [...requested, ...requestEvents]
    const live = pending.reduce(
      (state, event, index) => machineOf(parent).step(state, eventAt(event, index + 1)),
      machineOf(parent).initial()
    )
    const restarted = replayState(machineOf(parent), pending)
    expect(machineOf(parent).output(live).view).toEqual(machineOf(parent).output(restarted).view)
    expect(
      machineOf(parent)
        .output(live)
        .transitions.map((transition) => transition.key)
    ).toEqual(
      machineOf(parent)
        .output(restarted)
        .transitions.map((transition) => transition.key)
    )
    const request = { callId: String(requestEvents[0]!.callId), turn: "turn" }
    const settled = [
      ...pending,
      decision === "grant" ? child.budget.grant(2, request, 4) : child.budget.deny("enough", request, 4)
    ]
    const state = replayState(machineOf(parent), settled)
    const output = machineOf(parent).output(state)
    expect(machineOf(parent).output(state).view).toMatchObject({
      used: 2,
      limit: decision === "grant" ? 3 : 1,
      phase: decision === "grant" ? "spending" : "denied"
    })
    expect(output.view.tools.map((tool) => tool.spec.name)).toEqual(decision === "grant" ? ["read"] : [])
    const answers = eventsOf(output.transitions).filter(
      (event) => event.type === "ToolReturned" && event.callId === "ask"
    )
    expect(answers).toHaveLength(1)
    expect(eventsOf(output.transitions).filter((event) => event.type === "BudgetExhausted")).toEqual([])
    expect(answers[0]?.result).toMatchObject(decision === "grant" ? { granted: 2 } : { denied: true, reason: "enough" })
    const finished = replayState(machineOf(parent), [...settled, ...answers])
    expect(
      eventsOf(machineOf(parent).output(finished).transitions).filter(
        (event) => event.type === "ToolReturned" && event.callId === "ask"
      )
    ).toEqual([])
  })
}
