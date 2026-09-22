import { expect, expectTypeOf, test } from "bun:test"
import { componentContractOf } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { testMachineOf as machineOf } from "../../../fixtures/component"
import { requestBudgetMethod } from "../../actor/budget"
import { requestPermissionMethod } from "../../actor/permission"
import { escalate, caller } from "./index"

const budgetRequest = {
  type: "BudgetRequestReceived",
  id: "r1",
  request: "tool",
  turn: "turn",
  amount: 3,
  reason: "finish"
}
const permissionRequest = {
  type: "PermissionRequestReceived",
  id: "r1",
  request: "tool",
  turn: "turn",
  tool: "write",
  action: "write",
  reason: "finish"
}

for (const mode of ["manual", "local"] as const) {
  test(`${mode} authorities declare handling and expose typed pending inputs`, () => {
    const budget = escalate.authority("budget", mode === "manual" ? "manual" : { decide: (request) => request.grant() })
    const permission = escalate.authority(
      "permissions",
      mode === "manual" ? "manual" : { decide: (request) => request.deny() }
    )
    expect(componentContractOf(budget).handles).toEqual([
      { method: requestBudgetMethod, handling: mode === "manual" ? "external" : "local" }
    ])
    expect(componentContractOf(permission).handles).toEqual([
      { method: requestPermissionMethod, handling: mode === "manual" ? "external" : "local" }
    ])
    expectTypeOf(
      replayProjection(machineOf(budget), [budgetRequest]).view.pending[0]!.input.amount
    ).toEqualTypeOf<number>()
    expectTypeOf(
      replayProjection(machineOf(permission), [permissionRequest]).view.pending[0]!.input.action
    ).toEqualTypeOf<string>()
  })
}

test("policy exceptions and invalid decisions become durable failures", () => {
  const cases = [
    {
      output: (log: ReadonlyArray<Event>) => replayProjection(machineOf(escalate.authority("budget", {
        decide: () => {
          throw new Error("unavailable")
        }
      })), log),
      request: budgetRequest,
      type: "BudgetRequestFailed",
      error: "unavailable"
    },
    {
      output: (log: ReadonlyArray<Event>) => replayProjection(machineOf(escalate.authority("budget", { decide: (request) => request.grant(0) })), log),
      request: budgetRequest,
      type: "BudgetRequestFailed",
      error: "positive integer"
    },
    {
      output: (log: ReadonlyArray<Event>) => replayProjection(machineOf(escalate.authority("permissions", { decide: () => ({ granted: false }) as never })), log),
      request: permissionRequest,
      type: "PermissionRequestFailed",
      error: "PermissionDecision"
    }
  ]
  for (const { output, request, type, error } of cases) {
    const work = output([request]).transitions[0]!
    if (work.kind !== "intent") throw new Error("expected decision")
    const events = work.events(work.input, 1)
    expect(events).toMatchObject([{ type, callId: "r1", error: expect.stringContaining(error) }])
    expect(output([request, ...events]).view.pending).toEqual([])
    expect(output([request, ...events]).transitions).toEqual([])
  }
})

test("a missing caller settles delegation as a failure", () => {
  const authority = escalate.authority("budget", { delegate: caller() })
  const output = replayProjection(machineOf(authority), [budgetRequest])
  const work = output.transitions[0]!
  if (work.kind !== "intent") throw new Error("expected failure")
  expect(work.events(work.input, 1)).toMatchObject([
    { type: "BudgetRequestFailed", callId: "r1", error: "No caller authority is available" }
  ])
})
