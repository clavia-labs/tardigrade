import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { Prompt } from "effect/ai"
import { Agent, AskBudget, AskPermission, ModelInfo, pendingTools, permissions, toolBudget } from "@clavia/tardigrade-agent"
import { defineActor } from "@clavia/tardigrade-core"
import { Library } from "@clavia/tardigrade-libraries"
import { host } from "../../src/bun"
import { contentModelServices } from "../fixtures/agent"

const echo = Library.make("echo", Rpc.make("say", { payload: Schema.Struct({ text: Schema.String }), success: Schema.String, error: Schema.String }))

test("agent construction and inspection require no executable library handlers", async () => {
  let prompts = 0
  const contextual = echo.pipe(Library.context({ system: Effect.sync(() => { prompts++; return "Library instructions" }) }))
  const actor = defineActor("composed", Effect.gen(function* () {
    const tools = yield* Agent.tools([contextual])
    const context = yield* Agent.compact(Agent.messages, { triggerRatio: 0.7, retainRatio: 0.4 })
    return yield* Agent.make({ system: "Test", tools, context })
  }))
  const model = Layer.succeed(ModelInfo, { model: { provider: "test", model_id: "test" }, contextWindowTokens: 4096 })
  const inspection = await Effect.runPromise(actor.inspect.pipe(Effect.provide(model)))
  expect(Object.keys(inspection.methods)).toContain("message")
  expect(inspection.durableAtoms.length).toBeGreaterThan(0)
  await Effect.runPromise(actor.graph().pipe(Effect.provide(model)))
  expect(prompts).toBe(0)
})

for (const dynamicSystem of [false, true]) test(`composed agents execute tools and preserve library context after recovery (dynamicSystem=${dynamicSystem})`, async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-composed-"))
  const prompts: Prompt.Prompt[] = []
  const calls: string[] = []
  let resolutions = 0
  const contextual = echo.pipe(Library.context({
    system: "Library instructions",
    user: "Library user context",
  }))
  const actor = defineActor("composed", Effect.gen(function* () {
    const tools = yield* Agent.tools([contextual])
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({
      system: dynamicSystem ? Effect.sync(() => { resolutions++; return "Actor instructions" }) : "Actor instructions",
      tools, context,
    })
  }))
  const model = contentModelServices(prompt => prompts.push(prompt), {
    toolCalls: [{ id: "echo-call", name: "echo__say", params: { text: "hello" } }],
  })
  const implementation = Layer.succeed(echo, {
    say: ({ text }) => Effect.sync(() => { calls.push(text); return text }),
  })
  const open = () => Effect.runPromise(host(actor, { storage, layer: Layer.merge(model, implementation) }))
  let runtime = await open()
  try {
    expect(resolutions).toBe(0)
    const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Use echo" }, { id: "first" }))
    expect(await Effect.runPromise(thread.result("message", "first"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(calls).toEqual(["hello"])
    if (dynamicSystem) expect(resolutions).toBeGreaterThan(0)
    else expect(resolutions).toBe(0)
    const system = prompts[0]!.content.filter(message => message.role === "system").map(message => message.content).join("\n")
    expect(system).toContain("Actor instructions")
    expect(system).toContain("Library instructions")
    const users = prompts[0]!.content.filter(message => message.role === "user")
    expect(users).toHaveLength(1)
    expect(JSON.stringify(users)).toContain("Library user context")
    await Effect.runPromise(runtime.close)
    runtime = await open()
    const recovered = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(recovered.invoke("message", { text: "Continue" }, { id: "second" }))
    expect(await Effect.runPromise(recovered.result("message", "second"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(calls).toEqual(["hello"])
    expect(JSON.stringify(prompts.at(-1))).toContain("Library user context")
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(storage, { recursive: true, force: true })
  }
})

test("composed agents work with an empty tool declaration", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-composed-empty-"))
  const actor = defineActor("empty", Effect.gen(function* () {
    const tools = yield* Agent.tools([])
    const context = yield* Agent.compact(Agent.messages)
    return yield* Agent.make({ system: "Test", tools, context })
  }))
  const runtime = await Effect.runPromise(host(actor, { storage, layer: contentModelServices(() => {}) }))
  try {
    const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Hello" }, { id: "hello" }))
    expect(await Effect.runPromise(thread.result("message", "hello"))).toEqual({ status: "completed", output: { text: "ok" } })
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(storage, { recursive: true, force: true })
  }
})

for (const policy of ["allow", "deny"] as const) for (const maxCalls of [0, 1]) {
  test(`composed tool wrappers enforce permission=${policy}, maxCalls=${maxCalls}`, async () => {
    const storage = await mkdtemp(join(tmpdir(), "tardie-composed-governed-"))
    let calls = 0
    const actor = defineActor("governed", Effect.gen(function* () {
      const available = yield* Agent.tools([echo])
      const permission = permissions(pendingTools, { tools: available, policy: { default: policy, actions: {} } })
      const permitted = Agent.withPermissions(available, permission)
      const tools = Agent.withBudget(permitted, toolBudget(pendingTools, { maxCalls, requestTool: "request_budget" }))
      const context = yield* Agent.compact(Agent.messages)
      return yield* Agent.make({ system: "Test", tools, context })
    }))
    const model = contentModelServices(() => {}, {
      toolCalls: [{ id: "governed-call", name: "echo__say", params: { text: "hello" } }],
    })
    const implementation = Layer.succeed(echo, { say: ({ text }) => Effect.sync(() => { calls++; return text }) })
    const runtime = await Effect.runPromise(host(actor, { storage, layer: Layer.mergeAll(model, implementation, AskBudget.layer(() => Effect.die("No budget request expected")), AskPermission.layer(() => Effect.die("No permission request expected"))) }))
    try {
      const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
      await Effect.runPromise(thread.invoke("message", { text: "Use echo" }, { id: "governed" }))
      expect(await Effect.runPromise(thread.result("message", "governed"))).toEqual({ status: "completed", output: { text: "ok" } })
      expect(calls).toBe(policy === "allow" && maxCalls > 0 ? 1 : 0)
    } finally {
      await Effect.runPromise(runtime.close)
      await rm(storage, { recursive: true, force: true })
    }
  })
}
