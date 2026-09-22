import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { type Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { type Transition } from "@clavia/tardigrade-core/runtime"
import { tool } from "../src/component/tool/index"
import { budget } from "../src/component/budget/index"
import { permissions } from "../src/component/permissions/index"

const head: Event = { type: "MessageReceived", id: "turn", text: "go", budget: 1, at: 0 }
const called = (callId: string, name = "read"): Event => ({
  type: "ToolCalled",
  callId,
  name,
  arguments: { path: callId },
  turn: "turn",
  at: 1
})
const reader = () =>
  tool({ spec: { name: "read", description: "read", inputSchema: {} }, run: () => Effect.succeed({ error: "failed" }) })
const eventsOf = (transitions: ReadonlyArray<Transition<never, unknown>>): ReadonlyArray<Event> =>
  transitions.flatMap((transition) => (transition.kind === "intent" ? transition.events(transition.input, 1) : []))

test("budget supplies a result through tools without running refused work", async () => {
  const executed: string[] = []
  const child = tool({
    spec: { name: "read", description: "read", inputSchema: {} },
    run: (_input, context) =>
      Effect.sync(() => {
        executed.push(context.callId)
        return { error: "external failure" }
      })
  })
  const governed = budget(child, {
    limit: 1,
    onExhausted: (_reason, settle) => {
      expectTypeOf<Parameters<typeof settle>[0]>().toEqualTypeOf<unknown>()
      return settle({ error: "no more budget" })
    },
    usage: (observation) => observation.calls.length,
    view: (view, state) =>
      state.phase === "spending"
        ? view
        : {
            ...view,
            tools: [],
            system: [...view.system, "Your tool budget is spent. Answer now with what you have."]
          }
  })
  const log = [head, called("a"), called("b")]
  const state = replayState(machineOf(governed), log)
  const output = machineOf(governed).output(state)
  const refused = eventsOf(output.transitions).find((event) => event.type === "ToolReturned")!
  expect(refused).toMatchObject({
    callId: "b",
    result: { error: "no more budget" },
    transitionRef: { component: "tools.dispatch", tag: "answer" }
  })
  const executions = output.transitions.filter((transition) => transition.kind === "effect")
  expect(executions).toHaveLength(1)
  const execution = replayProjection(machineOf(child), log).transitions.find(
    (transition) => transition.key === executions[0]!.key
  )!
  if (execution.kind !== "effect") throw new Error("expected execution")
  const returned = await Effect.runPromise(
    execution
      .act(execution.input, new AbortController().signal)
      .pipe(Effect.provideService(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed(log) })))
  )
  expect(executed).toEqual(["a"])
  expect(returned).toContainEqual(
    expect.objectContaining({
      callId: "a",
      result: { error: "external failure" },
      transitionRef: { seq: 2, component: "tools.dispatch", tag: "answer" }
    })
  )
  const settled = replayState(machineOf(governed), [...log, ...eventsOf(output.transitions), ...returned])
  expect(machineOf(governed).output(settled).view.used).toBe(2)
  expect(machineOf(governed).output(settled).transitions).toEqual([])
})

test("permission refusal consumes no budget", () => {
  const permission = permissions(reader(), {
    request: () => ({ action: "read", reason: "read file" }),
    onDenied: (_reason, respond) => respond({ error: "permission denied" })
  })
  const governed = budget(permission, {
    onExhausted: (reason, settle) => settle({ error: reason }),
    usage: ({ permissions }) => permissions.filter(permission => permission.status === "allowed").length
  })
  const log = [head, called("a"), { type: "PermissionRequestDecided", callId: 'permission/[2,"tools.dispatch","answer"]', granted: false }]
  const output = replayProjection(machineOf(governed), log)
  const events = eventsOf(output.transitions)
  expect(events).toContainEqual(
    expect.objectContaining({ type: "ToolReturned", callId: "a", result: { error: "permission denied" } })
  )
  expect(output.transitions.some((transition) => transition.kind === "effect")).toBe(false)
  expect(machineOf(governed).output(replayState(machineOf(governed), [...log, ...events])).view.used).toBe(0)
})
