import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ToolReturned } from "@clavia/tardigrade-agent/contracts/events"
import { toolReturnedVersions } from "@clavia/tardigrade-agent/contracts/events/tool-returned/upcast"
import { createEventLog, durableAtom, type Recorded } from "@clavia/tardigrade-core"
import { trajectoryState, TrajectoryState } from "@clavia/tardigrade-agent/atoms/durable/trajectory"

const base = { type: "ToolReturned" as const, callId: "call", error: null }
const content = [{ type: "text" as const, text: "Image captured" }, {
  type: "file" as const, mediaType: "image/png", byteSize: 10,
  object: { algorithm: "sha256" as const, digest: "a".repeat(64) },
}]
const state: typeof TrajectoryState.Type = { models: [], entries: [{ turnId: "turn", message: {
  role: "assistant", text: "", toolCalls: [{ callId: "call", providerId: "provider-call", name: "capture", input: {} }],
} }] }
const decode = Schema.decodeUnknownSync(ToolReturned, { onExcessProperty: "error" })

test("historical tool events upcast to content-only version one", () => {
  for (const payload of [{ output: "legacy" }, { content }, { output: "legacy", content }]) {
    const event = { ...base, ...payload }
    expect(toolReturnedVersions.decode(JSON.parse(JSON.stringify(event)))).toEqual({ ...base, version: 1, content: payload.content ?? [{ type: "text", text: "legacy" }] })
  }
  const promise = { type: "promise" as const, ref: { seq: 1, atom: "tools", act: "execution" }, handle: { executor: "local", id: "job" } }
  const legacy = { ...base, output: '{"content":["ordinary data"]}', error: "failed", promise }
  expect(toolReturnedVersions.decode(JSON.parse(JSON.stringify(legacy)))).toEqual({
    ...base, version: 1, content: [{ type: "text", text: legacy.output }], error: legacy.error, promise,
  })
  expect(() => toolReturnedVersions.decode(base)).toThrow()
  expect(() => decode({ ...base, output: "legacy" })).toThrow()
  expect(() => toolReturnedVersions.decode({ ...base, version: 2, content })).toThrow()
})

test("tool history reaches trajectory with literal text, media, and error semantics intact", () => {
  for (const payload of [{ output: "legacy" }, { content }, { output: "ignored", content }, { version: 1, content, error: "Capture failed" }]) {
    const log = createEventLog({ schema: ToolReturned, atoms: { trajectory: durableAtom({
      name: "trajectory", input: ToolReturned, schema: TrajectoryState, initial: state, reduce: trajectoryState,
    }) } })
    try {
      const records = JSON.parse(JSON.stringify([{ recordedAt: 10, event: { ...base, ...payload } }])) as readonly Recorded<ToolReturned>[]
      const snapshot = log.replay(records)
      const error = "error" in payload ? payload.error : null
      expect(snapshot.view().trajectory.entries.at(-1)?.message).toEqual({
        role: "tool", callId: "call", providerId: "provider-call", name: "capture", error: error !== null,
        text: error ?? ("content" in payload ? "Image captured" : "legacy"),
        ...("content" in payload && error === null ? { content } : {}),
      })
      expect(records[0]?.recordedAt).toBe(10)
    } finally { log.dispose() }
  }
})
