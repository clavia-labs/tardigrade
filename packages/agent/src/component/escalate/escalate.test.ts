import { expect, expectTypeOf, test } from "bun:test"
import { Effect } from "effect"
import { componentContractOf } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { threadAddressOf } from "@clavia/tardigrade-core/transport/endpoint"
import { linkOf } from "@clavia/tardigrade-core/transport/link"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { budget } from "../budget/index"
import { permissions } from "../permissions/index"
import { tool } from "../tool/index"
import { escalate, caller } from "./index"
import { requestBudgetMethod } from "../../actor/budget"
import { requestPermissionMethod } from "../../actor/permission"

const tools = () =>
  tool({ spec: { name: "work", description: "work", inputSchema: {} }, run: () => Effect.succeed("done") })
const budgeted = () =>
  budget(tools(), {
    limit: 1,
    usage: ({ calls }) => calls.length,
    onExhausted: (reason, respond) => respond({ error: reason })
  })
const pendingBudget: Event = {
  type: "BudgetRequestReceived",
  id: "child",
  request: "call",
  turn: "turn",
  amount: 2,
  reason: "finish"
}
const head: Event = {
  type: "MessageReceived",
  id: "turn",
  text: "work",
  link: linkOf(threadAddressOf("parent", "main", "root"), threadAddressOf("child", "main", "root"))
}

test("escalate optionally encapsulates incoming budget authority", () => {
  const wrapped = escalate(budgeted(), { authority: caller(), requests: { decide: (request) => request.grant(1) } })
  expect(componentContractOf(wrapped).handles).toContainEqual({ method: requestBudgetMethod, handling: "local" })
  const output = replayProjection(machineOf(wrapped), [pendingBudget])
  const events = output.transitions.flatMap((work) => (work.kind === "intent" ? work.events(work.input, 1) : []))
  expect(events).toContainEqual(expect.objectContaining({ type: "BudgetRequestDecided", callId: "child", grant: 1 }))
  expect(componentContractOf(escalate(budgeted(), { authority: caller() })).handles).toEqual([])
})

test("encapsulated manual authority exposes requests and response interactions", () => {
  const wrapped = escalate(budgeted(), { authority: caller(), requests: "manual" })
  const output = replayProjection(machineOf(wrapped), [pendingBudget])
  expect(output.view.requests).toHaveLength(1)
  expectTypeOf(output.view.requests[0]!.input.amount).toEqualTypeOf<number>()
  const response = output.interactions!.respond("child", { granted: 2 })!
  const events = response.events(response.input, 1)
  expect(replayProjection(machineOf(wrapped), [pendingBudget, ...events]).view.requests).toEqual([])
})

test("permission escalation targets the parent without releasing execution", () => {
  const policy = permissions(tools(), { request: () => ({ action: "write", reason: "save" }), onDenied: (reason, respond) => respond({ error: reason }) })
  const log = [{ type: "ThreadCreated", address: threadAddressOf("agent", "main", "child"), depth: 0, at: 0 }, head, { type: "ToolCalled", callId: "call", name: "work", arguments: {}, turn: "turn" }]
  expect(replayProjection(machineOf(policy), log).transitions).toEqual([])
  const wrapped = escalate(policy, {
    authority: caller(),
    requests: { decide: (request) => request.deny("read only") }
  })
  expect(componentContractOf(wrapped).handles).toContainEqual({ method: requestPermissionMethod, handling: "local" })
  const output = replayProjection(machineOf(wrapped), log)
  expect(output.transitions.every((work) => work.kind === "intent")).toBe(true)
  const events = output.transitions.flatMap((work) => (work.kind === "intent" ? work.events(work.input, 1) : []))
  expect(events).toContainEqual(
    expect.objectContaining({ type: "CallPlanned", method: "requestPermission", target: "parent:main:root" })
  )
  expect(output.view.permissions.map(permission => permission.status)).toEqual(["pending"])
})
