import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer } from "effect"
import type { Prompt } from "effect/ai"
import { agent } from "@clavia/tardigrade-agent"
import { DEFAULT_WORKSPACE_SYSTEM, Library, log, workspace } from "@clavia/tardigrade-libraries"
import { host, journal, localWorkspace } from "../../src/bun"
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


test("workspace context refreshes between model calls and survives recovery without changing earlier prompts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-workspace-context-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  await writeFile(join(directory, "a.txt"), "A")
  const written = Deferred.makeUnsafe<void>()
  const releaseWrite = Deferred.makeUnsafe<void>()
  const paused = Deferred.makeUnsafe<Prompt.Prompt>()
  const operations: string[] = []
  const listings: string[] = []
  const prompts: Prompt.Prompt[] = []
  let pause = true
  let instructionRuns = 0
  const observedWorkspace = Layer.effect(workspace, Effect.map(workspace, implementation => ({
    ...implementation,
    bash: (input, request) => Effect.sync(() => { operations.push("list") }).pipe(
      Effect.andThen(implementation.bash(input, request)),
      Effect.tap(output => Effect.sync(() => { listings.push(output) })),
    ),
    write: (input, request) => implementation.write(input, request).pipe(Effect.tap(() => Effect.gen(function* () {
      yield* Deferred.succeed(written, undefined)
      yield* Deferred.await(releaseWrite)
      operations.push("write-finished")
    }))),
  } satisfies typeof workspace.Service))).pipe(Layer.provide(localWorkspace({ directory })))
  const model = contentModelServices(prompt => { prompts.push(prompt) }, {
    request: { retry: { backoffMs: [] } },
    toolCalls: [{ id: "write-b", name: "workspace__write", params: { path: "b.txt", content: "B" } }],
    beforeResponse: prompt => pause && prompt.content.some(message => message.role === "tool")
      ? Deferred.succeed(paused, prompt).pipe(Effect.andThen(Effect.never)) : Effect.void,
  })
  const assistant = agent({
    name: "workspace-context", tools: [workspace], compaction: { pageSize: 1 },
    system: Effect.sync(() => { instructionRuns++; return "Maintain the workspace." }),
  })
  const open = () => host(assistant, {
    storage: join(root, "host"), layer: Layer.merge(model, observedWorkspace),
    checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } },
  })
  let runtime = await Effect.runPromise(open())
  try {
    let thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Create b.txt" }, { id: "create" }))
    await Effect.runPromise(Deferred.await(written))
    expect(listings).toHaveLength(1)
    expect(instructionRuns).toBe(1)
    expect(listings[0]).toContain("./a.txt")
    expect(listings[0]).not.toContain("./b.txt")
    expect(operations).toEqual(["list"])
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined))
    const second = await Effect.runPromise(Deferred.await(paused))
    expect(operations).toEqual(["list", "write-finished", "list"])
    expect(listings).toHaveLength(2)
    expect(instructionRuns).toBe(2)
    expect(listings[1]).toContain("./b.txt")
    expect(listings[1]).not.toContain("./c.txt")
    expect(second.content.slice(0, prompts[0]!.content.length)).toEqual([...prompts[0]!.content])
    const tail = second.content.at(-1)
    expect(tail?.role).toBe("user")
    expect(tail?.role === "user" && tail.content.some(part => part.type === "text" && part.text.includes("./b.txt"))).toBe(true)
    const before = await Effect.runPromise(thread.records())
    const snapshots = before.flatMap(record => record.event.type === "ContextResolved" ? [record.event] : [])
    const calls = before.flatMap(record => record.event.type === "ModelCalled" && record.event.purpose === "inference" ? [record.event] : [])
    expect(snapshots.map(event => ({ turnId: event.turnId, callId: event.callId }))).toEqual(calls.map(event => ({ turnId: event.turnId, callId: event.callId })))
    expect(snapshots).toHaveLength(2)
    expect(before.findIndex(record => record.event.type === "ContextResolved" && record.event.callId === calls[1]!.callId))
      .toBeGreaterThan(before.findIndex(record => record.event.type === "ToolReturned"))
    const coordinate = thread.coordinate
    await Effect.runPromise(runtime.close)
    await writeFile(join(directory, "c.txt"), "C")
    pause = false
    runtime = await Effect.runPromise(open())
    const restored = await Effect.runPromise(runtime.getThread(coordinate))
    expect(restored).toBeDefined()
    thread = restored!
    expect(await Effect.runPromise(thread.result("message", "create"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toEqual(second)
    expect(listings).toHaveLength(2)
    expect(instructionRuns).toBe(2)
    await Effect.runPromise(thread.invoke("message", { text: "Inspect again" }, { id: "inspect" }))
    expect(await Effect.runPromise(thread.result("message", "inspect"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(listings).toHaveLength(3)
    expect(instructionRuns).toBe(3)
    expect(listings[2]).toContain("./c.txt")
    expect(prompts).toHaveLength(3)
    expect(prompts[2]!.content.slice(0, second.content.length)).toEqual([...second.content])
    const latest = prompts[2]!.content.at(-1)
    expect(latest?.role === "user" && latest.content.some(part => part.type === "text" && part.text.includes("./c.txt"))).toBe(true)
    const after = await Effect.runPromise(thread.records())
    expect(after.filter(record => record.event.type === "ContextResolved")).toHaveLength(3)
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined))
    await Effect.runPromise(runtime.close)
    await rm(root, { recursive: true, force: true })
  }
})

test("disabling workspace user context skips file listings and preserves system instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-workspace-context-disabled-"))
  let listings = 0
  let prompt: Prompt.Prompt | undefined
  const observedWorkspace = Layer.effect(workspace, Effect.map(workspace, implementation => ({
    ...implementation,
    bash: (input, request) => Effect.sync(() => { listings++ }).pipe(Effect.andThen(implementation.bash(input, request))),
  } satisfies typeof workspace.Service))).pipe(Layer.provide(localWorkspace({ directory: join(root, "workspace") })))
  const runtime = await Effect.runPromise(host(agent({
    name: "workspace-context-disabled", system: "Maintain the workspace.", tools: [workspace.pipe(Library.context({ user: null }))],
  }), { storage: join(root, "host"), layer: Layer.merge(contentModelServices(value => { prompt = value }), observedWorkspace) }))
  try {
    const thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Hello" }, { id: "hello" }))
    expect(await Effect.runPromise(thread.result("message", "hello"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(listings).toBe(0)
    expect(prompt?.content.some(message => message.role === "system" && message.content.includes(DEFAULT_WORKSPACE_SYSTEM))).toBe(true)
    const user = prompt?.content.find(message => message.role === "user")
    expect(user?.role === "user" && user.content.flatMap(part => part.type === "text" ? [part.text] : [])).toEqual(["Hello"])
    const records = await Effect.runPromise(thread.records())
    expect(records.some(record => record.event.type === "ContextResolved")).toBe(false)
  } finally {
    await Effect.runPromise(runtime.close)
    await rm(root, { recursive: true, force: true })
  }
})
