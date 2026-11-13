import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { Prompt } from "effect/ai"
import { agent } from "@clavia/tardigrade-agent"
import { log } from "@clavia/tardigrade-libraries"
import { host, journal } from "../../src/bun"
import { contentModelServices } from "../fixtures/agent"
import { contentScenarios } from "../properties/content/hydration"
import { bunContentFixture } from "../fixtures/bun/content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await bunContentFixture()
  try {
    await scenario.run(fixture)
    if (scenario === contentScenarios[0]) {
      await fixture.reopen()
      expect(await fixture.message([{ type: "text", text: "Again" }], "again")).toEqual({ status: "completed", output: { text: "ok" } })
      const users = fixture.prompt()?.content.filter(message => message.role === "user")
      expect(users?.map(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []))).toEqual([["Before", "After"], ["Again"]])
      const file = users?.[0]?.content.find(part => part.type === "file")
      expect(file?.type === "file" && file.data).toEqual(new TextEncoder().encode("photo"))
    }
  } finally { await fixture.close() }
})

test("an agent corrects invalid tool arguments after receiving a tool failure", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-tool-recovery-"))
  const feedback: Prompt.ToolResultPart[] = []
  const handled: unknown[] = []
  const observedJournal = Layer.effect(log, Effect.map(log, implementation => {
    const handlers: typeof log.Service = {
      ...implementation,
      search: (input, request) => Effect.sync(() => { handled.push(input) }).pipe(
        Effect.andThen(implementation.search(input, request)),
      ),
    }
    return handlers
  })).pipe(Layer.provide(journal()))
  const model = contentModelServices(() => {}, { request: { retry: { backoffMs: [] } }, toolCalls: prompt => {
    const results = prompt.content.flatMap(message => message.role === "tool" ? message.content.filter(part => part.type === "tool-result") : [])
    if (!results.length) return [{ id: "invalid", name: "log__search", params: { query: "orchid", type: "" } }]
    feedback.push(results.at(-1)!)
    return results.length === 1 ? [{ id: "corrected", name: "log__search", params: { query: "orchid", type: "TurnRequested" } }] : []
  } })
  const runtime = await Effect.runPromise(host(agent({ name: "tool-recovery", system: "Search event history.", tools: [log] }), {
    storage, layer: Layer.merge(model, observedJournal),
  }))
  try {
    const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Find orchid in my history" }, { id: "search" }))
    expect(await Effect.runPromise(thread.result("message", "search"))).toEqual({ status: "completed", output: { text: "ok" } })
    const records = await Effect.runPromise(thread.records())
    const returned = records.flatMap(record => record.event.type === "ToolReturned" ? [record.event] : [])
    expect(returned).toHaveLength(2)
    const calls = records.flatMap(record => record.event.type === "ModelReturned" && record.event.purpose === "inference" ? record.event.toolCalls : [])
    expect(calls.map(call => call.providerId)).toEqual(["invalid", "corrected"])
    expect(returned.map(result => result.callId)).toEqual(calls.map(call => call.callId))
    expect(returned.map(result => ({ turnId: result.turnId, providerId: result.tool?.providerId }))).toEqual([
      { turnId: "search", providerId: "invalid" },
      { turnId: "search", providerId: "corrected" },
    ])
    expect(returned[0]!.error).not.toBeNull()
    expect(returned[1]!.error).toBeNull()
    expect(returned[1]!.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("Find orchid in my history") })])
    expect(feedback.map(result => ({ id: result.id, name: result.name, isFailure: result.isFailure }))).toEqual([
      { id: "invalid", name: "log__search", isFailure: true },
      { id: "corrected", name: "log__search", isFailure: false },
    ])
    expect(feedback[0]!.result).toBe(returned[0]!.error)
    expect(handled).toEqual([{ query: "orchid", type: "TurnRequested" }])
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(storage, { recursive: true, force: true })
  }
})
