import { testMachineOf as machineOf } from "@clavia/tardigrade-agent/fixtures/component"
import { expect, expectTypeOf, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { replayProjection, replayState } from "@clavia/tardigrade-core/projection"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { threadAddressOf, formatThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { permissions } from "../src/component/permissions/index"
import { toolCallOf } from "../src/component/tool/machine"
import { tool } from "../src/component/tool/index"
import { requestPermissionMethod } from "../src/actor/permission"

import { escalate } from "../src/component/escalate/index"

for (const granted of [false, true]) {
  test(`permission options preserve pending work and ${granted ? "forward allowed execution" : "replace denied execution with the supplied completion"}`, async () => {
    const source = threadAddressOf("agent", "main", "root")
    const target = threadAddressOf("permission", "main", "root")
    let executions = 0
    const child = tool({
      spec: { name: "read", description: "read", inputSchema: {} },
      run: () =>
        Effect.sync(() => {
          executions++
          return "ok"
        })
    })
    const governed = escalate(
      permissions(child, {
        request: () => ({ action: "read", reason: "read the document" }),
        onDenied: (reason, settle, work) => {
          const call = toolCallOf(work)!
          expectTypeOf(call.callId).toEqualTypeOf<string>()
          return settle({ refused: call.callId, reason })
        }
      }),
      {
        authority: {
          coordinate: target,
          methods: {
            requestPermission: requestPermissionMethod
          }
        }
      }
    )
    const log: Event[] = [
      { type: "ThreadCreated", address: source, depth: 0, at: 0 },
      { type: "MessageReceived", id: "turn", text: "go" },
      { type: "ToolCalled", callId: "a", name: "read", arguments: {}, turn: "turn" }
    ]
    const environment = Layer.mergeAll(
      Layer.succeed(Self, source),
      Layer.succeed(Router, { send: () => Effect.void }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed(log) }))
    )
    const planning = replayProjection(machineOf(governed), log).transitions[0]!
    expect(planning.kind).toBe("intent")
    if (planning.kind !== "intent") throw new Error("expected permission plan")
    log.push(...planning.events(planning.input, Date.now()))
    const dispatch = replayProjection(machineOf(governed), log).transitions[0]!
    if (dispatch.kind !== "effect") throw new Error("expected authority dispatch")
    log.push(
      ...(await Effect.runPromise(
        dispatch.act(dispatch.input, new AbortController().signal).pipe(Effect.provide(environment))
      ))
    )
    expect(replayProjection(machineOf(governed), log).transitions).toEqual([])
    expect(
      machineOf(governed)
        .output(replayState(machineOf(governed), log))
        .view.pendingCalls.map((call) => call.callId)
    ).toEqual(["a"])
    const plan = log.find((event) => event.type === "CallPlanned")!
    log.push({
      type: "ResponseReceived",
      reference: plan.reference,
      id: "reply",
      from: formatThreadAddress(target),
      method: "requestPermission",
      call: String(plan.id),
      epoch: 0,
      status: "completed",
      output: granted ? { granted: true } : { denied: true, reason: "private" },
      at: Date.now()
    })
    const decision = replayProjection(machineOf(governed), log).transitions[0]!
    expect(decision.kind).toBe("intent")
    if (decision.kind !== "intent") throw new Error("expected recorded permission decision")
    log.push(...decision.events(decision.input, Date.now()))
    const result = replayProjection(machineOf(governed), log).transitions
    expect(result).toHaveLength(1)
    const transition = result[0]!
    if (granted) {
      expect(transition.kind).toBe("effect")
      if (transition.kind !== "effect") throw new Error("expected tool execution")
      log.push(
        ...(await Effect.runPromise(
          transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(environment))
        ))
      )
      expect(executions).toBe(1)
      expect(log).toContainEqual(expect.objectContaining({ type: "ToolReturned", callId: "a", result: "ok" }))
      const settled = replayProjection(machineOf(governed), log)
      expect(settled.transitions).toEqual([])
      expect(settled.view.pendingCalls).toEqual([])
      expect(machineOf(governed).output(replayState(machineOf(governed), log)).view.calls).toHaveLength(1)
    } else {
      expect(executions).toBe(0)
      expect(transition.kind).toBe("intent")
      if (transition.kind !== "intent") throw new Error("expected replacement completion")
      const completed = transition.events(transition.input, Date.now())
      expect(completed).toMatchObject([
        { type: "ToolReturned", callId: "a", result: { refused: "a", reason: "private" } }
      ])
      log.push(...completed)
      expect(replayProjection(machineOf(governed), log).transitions).toEqual([])
      expect(machineOf(governed).output(replayState(machineOf(governed), log)).view.pendingCalls).toEqual([])
      expect(machineOf(governed).output(replayState(machineOf(governed), log)).view.permissions.map(permission => permission.status)).toEqual(["denied"])
    }
  })
}

test("tool validation completions bypass authorization without executing the tool", () => {
  const child = tool({
    spec: { name: "read", description: "read", inputSchema: {} },
    run: () => Effect.die("invalid work must not execute")
  })
  const governed = permissions(child, {
    request: () => { throw new Error("completion must not request permission") },
    onDenied: (reason, respond) => respond({ error: reason })
  })
  const log = [
    { type: "ToolCalled", callId: "invalid", name: "read", arguments: {}, validationError: "missing path" }
  ]
  const output = replayProjection(machineOf(governed), log)
  const completion = output.transitions[0]!
  expect(completion.respond).toBeUndefined()
  if (completion.kind !== "intent") throw new Error("expected validation completion")
  const events = completion.events(completion.input, 0)
  expect(events).toMatchObject([{ type: "ToolReturned", callId: "invalid", result: { error: "missing path" } }])
  expect(replayProjection(machineOf(governed), [...log, ...events]).transitions).toEqual([])
})
