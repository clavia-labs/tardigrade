import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Prompt, Response } from "effect/unstable/ai"
import { actionOf } from "./response"

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
