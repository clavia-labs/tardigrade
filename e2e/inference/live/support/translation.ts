import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import { Prompt, Tool, Toolkit } from "effect/unstable/ai"

import type { Event } from "@clavia/tardigrade-core/log/event"
import { collectResponse } from "../../../../packages/model/src/providers/response"
import { bindingFor, providerFor } from "./layers"
import type { ResolvedLiveTarget } from "./config"

const instruction = "Call read_nonce exactly once, then reply with the nonce returned by the tool."
const spec = { name: "read_nonce", description: "Read a secret nonce", inputSchema: { type: "object", properties: {}, additionalProperties: false } }

export const runProvider = (target: ResolvedLiveTarget) => {
  const nonce = crypto.randomUUID()
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const toolkit = Toolkit.make(Tool.make("read_nonce", { description: spec.description, parameters: Schema.Record(Schema.String, Schema.Never) }))
    const first = yield* collectResponse(instruction, toolkit)
    const calls = first.parts.filter((part) => part.type === "tool-call")
    assert.equal(calls.length, 1)
    const call = calls[0]!
    assert.equal(call.name, "read_nonce")
    assert.ok(call.id.length > 0)
    assert.deepEqual(call.params, {})
    if (target.behaviors.includes("reasoning")) assert.ok(first.parts.some((part) => part.type === "reasoning-start" || part.type === "reasoning-delta"), "Provider must return typed reasoning")
    const restored = yield* Schema.decodeUnknownEffect(Prompt.Prompt)(JSON.parse(JSON.stringify(first.continuation)))
    const result = Prompt.make([{ role: "tool", content: [{ type: "tool-result", id: call.id, name: call.name, result: { nonce }, isFailure: false }] }])
    const second = yield* collectResponse(Prompt.concat(restored, result), toolkit)
    assert.ok(second.parts.some((part) => part.type === "finish" && part.reason === "stop"))
    assert.ok(!second.parts.some((part) => part.type === "tool-call"))
    assert.ok(second.parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("").includes(nonce))
  })).pipe(Effect.provide(providerFor(target))))
}

export const runBinding = (target: ResolvedLiveTarget) => {
  const nonce = crypto.randomUUID()
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const infer = yield* inferenceClient
    const trajectory: Event[] = [{ type: "MessageReceived", id: "m1", text: instruction, at: 1 }]
    const request = { identity: { actor: "live", instance: "main", thread: "root", turn: "m1" }, system: instruction, tools: [spec], trajectory }
    const first = yield* infer.react(request, "live/0")
    assert.equal(first.kind, "calls", "Binding must return a tool request")
    if (first.kind !== "calls") return
    assert.equal(first.calls.length, 1)
    const call = first.calls[0]!
    assert.equal(call.name, "read_nonce")
    assert.deepEqual(call.arguments, {})
    assert.equal(call.validationError, undefined)
    assert.ok(first.continuation, "Binding must preserve continuation")
    trajectory.push(
      { type: "ModelCalled", callId: "r1", ordinal: 0, turn: "m1", at: 2 },
      { type: "ModelReturned", callId: "r1", ordinal: 0, turn: "m1", outcome: "returned", continuation: first.continuation, usage: first.usage, at: 3 },
      { type: "ToolCalled", callId: call.callId, responseId: "r1", name: call.name, arguments: call.arguments, turn: "m1", at: 4 },
      { type: "ToolReturned", callId: call.callId, result: { nonce }, turn: "m1", at: 5 }
    )
    const second = yield* infer.react({ ...request, trajectory: JSON.parse(JSON.stringify(trajectory)) }, "live/1")
    assert.equal(second.kind, "complete", "Binding must complete after the tool result")
    if (second.kind === "complete") assert.ok(second.output.includes(nonce))
  })).pipe(Effect.provide(bindingFor(target))))
}
