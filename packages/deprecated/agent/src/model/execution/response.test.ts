import { expect, test } from "bun:test"
import { DateTime, Effect, Redacted } from "effect"
import { Prompt, Response } from "effect/unstable/ai"
import { actionOf, responseEvidence } from "./response"

const hostile = <A extends object>(value: A, field: string): A => Object.defineProperty(value, field, {
  get() { throw new Error(`${field} accessor raised`) },
  enumerable: true
})

const metadataPart = (headers: Record<string, string>) => Response.makePart("response-metadata", {
  id: "resp_1",
  modelId: "gpt-5",
  timestamp: DateTime.makeUnsafe("2026-09-21T08:40:00Z"),
  request: { method: "POST" as const, url: "https://api.openai.com/v1/responses", urlParams: [], headers }
})

const finishPart = (metadata?: Response.FinishPart["metadata"]) => Response.makePart("finish", {
  reason: "stop" as const,
  usage: Response.Usage.make({ inputTokens: { total: 10, uncached: 10 }, outputTokens: { total: 2, text: 2 } }),
  ...(metadata === undefined ? {} : { metadata })
})

for (const local of [false, true]) {
  test(`provider-executed calls remain replayable without local dispatch (local: ${local})`, async () => {
    const parts = [
      Response.makePart("tool-call", { id: "hosted", name: "read", params: { path: "remote" }, providerExecuted: true }),
      Response.makePart("tool-result", { id: "hosted", name: "read", result: "remote result", encodedResult: "remote result", preliminary: false, isFailure: false, providerExecuted: true }),
      ...(local ? [Response.makePart("tool-call", { id: "local", name: "read", params: { path: "local" }, providerExecuted: false })] : [])
    ]
    const action = await Effect.runPromise(actionOf(parts, { text: "done", finish: { reason: "stop" } }, 1))
    expect(action).toMatchObject(local ? { kind: "calls", calls: [{ callId: "local" }] } : { kind: "complete", output: "done" })
    if (action.kind === "calls") expect(action.calls).toHaveLength(1)
    expect(JSON.stringify(Prompt.fromResponseParts(parts))).toContain("remote result")
  })
}

test("unencodable response metadata cannot discard a completed answer", () => {
  const evidence = responseEvidence([
    metadataPart(hostile({ "content-type": "application/json" }, "authorization") as Record<string, string>),
    Response.makePart("text-delta", { id: "text", delta: "done" }),
    finishPart()
  ])
  expect(evidence).toMatchObject({
    text: "done",
    response: { id: "resp_1", modelId: "gpt-5" },
    finish: { reason: "stop" },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } }
  })
  expect(evidence.response?.request).toBeUndefined()
  expect(Object.getPrototypeOf(evidence.usage)).toBe(Object.prototype)
  expect(() => JSON.stringify(evidence)).not.toThrow()
})

test("ordinary response metadata retains redacted request evidence", () => {
  const evidence = responseEvidence([
    metadataPart({ "content-type": "application/json", authorization: Redacted.make("secret") as unknown as string }),
    finishPart()
  ])
  expect(evidence.response?.request).toMatchObject({
    url: "https://api.openai.com/v1/responses",
    headers: { authorization: "<redacted>" }
  })
  expect(evidence.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 2 } })
})

test("unencodable finish metadata retains reason and plain usage", () => {
  const evidence = responseEvidence([
    finishPart(hostile({ provider: "openai" }, "response") as Response.FinishPart["metadata"])
  ])
  expect(evidence.finish).toMatchObject({ reason: "stop" })
  expect(evidence.finish?.metadata).not.toHaveProperty("response")
  expect(evidence.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 2 } })
  expect(Object.getPrototypeOf(evidence.usage)).toBe(Object.prototype)
  expect(() => JSON.stringify(evidence)).not.toThrow()
})
