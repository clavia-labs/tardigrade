import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { atom, defineActor } from "@clavia/tardigrade-core"
import { agentMethods, compact, infer, messages, ModelInfo } from "@clavia/tardigrade-agent"
import { Model, modelActs } from "@clavia/tardigrade-agent/services/model"
import { createBunHost } from "../../src/bun"

const actor = defineActor("adapter-usage", Effect.gen(function*() {
  const context = yield* compact(messages)
  return {atom: yield* infer(atom(get => ({system: "Continue.", tools: {view: {specs: []}, events: {}, acts: {}}, context: get(context)}))), methods: agentMethods}
}))

test("adapter model attribution survives compaction and settled replay", async () => {
  const storage = await mkdtemp(join(tmpdir(), "adapter-usage-"))
  const actual = {provider: "fixture", model_id: "summary"}
  const usage = {model: actual, input: 1000, output: 100, usd: 0.002}
  let calls = 0
  const open = () => Effect.runPromise(createBunHost({actor, storage, actorContext: Context.pick(ModelInfo), services: () => modelActs.pipe(Layer.provideMerge(Layer.mergeAll(
    Layer.succeed(ModelInfo, {model: {provider: "fixture", model_id: "inference"}, contextWindowTokens: 2000}),
    Layer.succeed(Model, Model.of({call: (_input, context) => Effect.sync(() => {
      calls++
      return context?.purpose === "compaction" ? {text: "Summary.", toolCalls: [], usage} : {text: "Answer.", toolCalls: [], usage: {input: 100, output: 10, usd: 0.01}}
    })})),
  ))) }))
  let host = await open()
  try {
    let thread = await Effect.runPromise(host.allocateRootThread({instance: "fixture", name: "one"}))
    const text = "A line of context.\n".repeat(250)
    await Effect.runPromise(thread.methods.message({text}, {id: "first"}))
    await Effect.runPromise(thread.methods.message({text}, {id: "second"}))
    const records = await Effect.runPromise(thread.records())
    const compacted = records.flatMap(({event}) => event.type === "ModelReturned" && event.purpose === "compaction" ? [event] : [])
    expect(compacted.length).toBeGreaterThan(0)
    expect(compacted.every(event => JSON.stringify(event.usage) === JSON.stringify(usage))).toBe(true)
    const count = calls, coordinate = thread.coordinate
    await Effect.runPromise(host.close)
    host = await open()
    const restored = await Effect.runPromise(host.getThread(coordinate))
    expect(restored).toBeDefined()
    if (!restored) throw new Error("Expected the retained thread")
    thread = restored
    await Effect.runPromise(thread.methods.message({text}, {id: "second"}))
    expect(await Effect.runPromise(thread.records())).toEqual(records)
    expect(calls).toBe(count)
  } finally {await Effect.runPromise(host.close); await rm(storage, {recursive: true, force: true})}
})
