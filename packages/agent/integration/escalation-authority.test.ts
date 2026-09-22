import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Self } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { threadAddressOf, formatThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { linkOf } from "@clavia/tardigrade-core/transport/link"
import { testMachineOf as machineOf } from "../fixtures/component"
import { escalate } from "../src/component/escalate/index"
import { requestBudgetMethod } from "../src/actor/budget"
import { caller } from "../src/component/escalate/target"
import type { AuthorityComponent } from "../src/component/escalate/authority"

const source = threadAddressOf("authority", "main", "parent")
const human = threadAddressOf("human", "main", "review")
const budgetRequest: Event = {
  type: "BudgetRequestReceived",
  id: "r1",
  request: "tool",
  turn: "turn",
  amount: 3,
  reason: "finish",
  link: linkOf(human, source)
}
const permissionRequest: Event = {
  type: "PermissionRequestReceived",
  id: "r1",
  request: "tool",
  turn: "turn",
  tool: "write",
  action: "write",
  resource: "file",
  reason: "finish",
  link: linkOf(human, source)
}

const exercise = async <Input, Decision>(
  authority: AuthorityComponent<Input, Decision, Router | Self>,
  manual: AuthorityComponent<Input, Decision>,
  received: Event,
  decision: Decision,
  expected: object
) => {
  const machine = machineOf(authority)
  const log: Event[] = [received]
  const planned = replayProjection(machine, log).transitions[0]!
  if (planned.kind !== "intent") throw new Error("expected delegation plan")
  log.push(...planned.events(planned.input, Date.now()))
  const plan = log.find((event) => event.type === "CallPlanned")!
  expect(plan.target).toBe(formatThreadAddress(human))
  expect(plan.input).toMatchObject({ request: "tool", turn: "turn", reason: "finish" })
  const dispatch = replayProjection(machine, log).transitions[0]!
  if (dispatch.kind !== "effect") throw new Error("expected delegation effect")
  let sent = 0
  log.push(
    ...(await Effect.runPromise(
      dispatch.act(dispatch.input, new AbortController().signal).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(Self, source),
            Layer.succeed(Router, {
              send: () =>
                Effect.sync(() => {
                  sent++
                })
            }),
            Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed(log) }))
          )
        )
      )
    ))
  )
  expect(sent).toBe(1)
  expect(replayProjection(machine, log).transitions).toEqual([])
  expect(replayProjection(machine, log).view.pending).toHaveLength(1)

  const humanLog = [{ ...received, id: plan.id, link: linkOf(source, human) }]
  const waiting = replayProjection(machineOf(manual), humanLog)
  expect(waiting.transitions).toEqual([])
  expect(waiting.view.pending[0]?.id).toBe(String(plan.id))
  const response = waiting.interactions!.respond(String(plan.id), decision)!
  expect(replayProjection(machineOf(manual), humanLog).view.pending).toHaveLength(1)
  const humanDecision = response.events(response.input, 2)
  expect(replayProjection(machineOf(manual), [...humanLog, ...humanDecision]).view.pending).toEqual([])
  expect(
    replayProjection(machineOf(manual), [...humanLog, ...humanDecision]).interactions!.respond(
      String(plan.id),
      decision
    )
  ).toBeUndefined()

  log.push({
    type: "ResponseReceived",
    reference: { target: source, invocation: { method: plan.method, id: plan.id, epoch: 0 } },
    id: "unrelated",
    method: plan.method,
    call: plan.id,
    status: "completed",
    output: decision
  })
  expect(replayProjection(machine, log).transitions).toEqual([])
  log.push({
    type: "ResponseReceived",
    reference: plan.reference,
    id: "response",
    from: formatThreadAddress(human),
    method: plan.method,
    call: plan.id,
    epoch: 0,
    status: "completed",
    output: decision,
    at: 3
  })
  const completion = replayProjection(machine, log).transitions[0]!
  if (completion.kind !== "intent") throw new Error("expected local decision")
  const events = completion.events(completion.input, 4)
  expect(events).toMatchObject([expected])
  expect(replayProjection(machine, [...log, ...events, received]).transitions).toEqual([])
  expect(replayProjection(machine, [...log, ...events, received]).view.pending).toEqual([])
}

test("a parent budget authority delegates to a human and replays the committed grant", async () => {
  await exercise(
    escalate.authority("budget", { delegate: { coordinate: human, methods: { requestBudget: requestBudgetMethod } } }),
    escalate.authority("budget", "manual"),
    budgetRequest,
    { granted: 2 },
    { type: "BudgetRequestDecided", callId: "r1", grant: 2 }
  )
})

test("a parent permission authority can delegate to its caller and replay a denial", async () => {
  await exercise(
    escalate.authority("permissions", { delegate: caller() }),
    escalate.authority("permissions", "manual"),
    permissionRequest,
    { denied: true, reason: "private" },
    { type: "PermissionRequestDecided", callId: "r1", granted: false, reason: "private" }
  )
})
