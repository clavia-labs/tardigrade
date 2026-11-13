import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/ai"
import { Rpc } from "effect/rpc"
import { contextProvider, type ContextRequest, type WireBlock } from "../fixtures/context-provider"
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


for (const provider of ["anthropic", "openai", "openrouter"] as const) {
for (const caching of ["automatic", "bounded", "manual", "disabled"] as const) {
test(`${provider}: workspace context and cache boundaries survive mutation and recovery (${caching})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-workspace-context-"))
  const directory = join(root, "workspace")
  await mkdir(directory)
  await writeFile(join(directory, "a.txt"), "A")
  await writeFile(join(directory, "PROJECT.md"), "Keep changes small.")
  const written = Deferred.makeUnsafe<void>()
  const releaseWrite = Deferred.makeUnsafe<void>()
  const paused = Deferred.makeUnsafe<ContextRequest>()
  const operations: string[] = []
  const listings: string[] = []
  const requests: ContextRequest[] = []
  let pause = true
  let instructionRuns = 0
  let projectRuns = 0
  const project = Library.make("project", Rpc.make("read", { payload: Schema.Struct({ path: Schema.String }), success: Schema.String, error: Schema.String }))
  const projectLayer = Layer.succeed(project, {
    read: ({ path }) => Effect.tryPromise({ try: () => { projectRuns++; return readFile(join(directory, path), "utf8") }, catch: String }),
  })
  const projectContext = project.pipe(Library.context({
    system: Effect.flatMap(project, service => service.read({ path: "PROJECT.md" })).pipe(Effect.map(text => [
      Prompt.makePart("text", { text: "Project instructions:" }),
      Prompt.makePart("text", { text, options: { fixture: { source: "project" } } }),
    ])),
  }))
  const observedWorkspace = Layer.effect(workspace, Effect.map(workspace, implementation => ({
    ...implementation,
    bash: (input, request) => Effect.sync(() => { operations.push("list") }).pipe(
      Effect.andThen(implementation.bash(input, request)),
      Effect.tap(output => Effect.sync(() => { listings.push(output) })),
    ),
    write: (input, request) => implementation.write(input, request).pipe(Effect.tap(() => input.path === "b.txt" ? Effect.gen(function* () {
      yield* Deferred.succeed(written, undefined)
      yield* Deferred.await(releaseWrite)
      operations.push("write-finished")
    }) : Effect.void)),
  } satisfies typeof workspace.Service))).pipe(Layer.provide(localWorkspace({ directory })))
  const model = contextProvider(provider, {
    ...(caching === "disabled" ? { promptCache: false as const } : caching === "bounded" ? { promptCache: { maxCheckpoints: 2 } } : {}),
    calls: [
      { id: "write-b", name: "workspace__write", input: { path: "b.txt", content: "B" } },
      { id: "update-project", name: "workspace__write", input: { path: "PROJECT.md", content: "Use explicit names." } },
    ],
    observe: request => {
      requests.push(request)
      if (pause && requests.length === 3) {
        Effect.runSync(Deferred.succeed(paused, request))
        return true
      }
      return false
    },
  })
  const manual = caching === "manual" ? provider === "openai"
    ? { openai: { promptCacheBreakpoint: { mode: "explicit" as const } } }
    : provider === "anthropic" ? { anthropic: { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } } }
    : { openrouter: { cacheControl: { type: "ephemeral" as const, ttl: "1h" as const } } } : {}
  const assistant = agent({
    name: "workspace-context", tools: [projectContext, workspace], compaction: { pageSize: 1 },
    system: Effect.sync(() => {
      instructionRuns++
      return [Prompt.makePart("text", { text: "Maintain the workspace." }), Prompt.makePart("text", { text: "Follow project instructions.", options: manual })]
    }),
  })
  const open = () => host(assistant, {
    storage: join(root, "host"), layer: Layer.mergeAll(model, observedWorkspace, projectLayer),
    checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } },
  })
  const systemBlocks = (request: ContextRequest): readonly WireBlock[] => request.system ?? (request.input ?? request.messages ?? [])
    .filter(message => message.role === "system" || message.role === "developer").flatMap(message => typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [])
  const userText = (request: ContextRequest) => (request.input ?? request.messages ?? [])
    .filter(message => message.role === "user").flatMap(message => typeof message.content === "string" ? [message.content] : (message.content ?? []).flatMap(part => part.text ?? [])).join("\n")
  const controlled = (block: WireBlock) => block.cache_control != null || block.prompt_cache_breakpoint != null
  let runtime = await Effect.runPromise(open())
  try {
    let thread = await Effect.runPromise(runtime.allocateRootThread({ instance: "main", name: "thread" }))
    await Effect.runPromise(thread.invoke("message", { text: "Create b.txt, then update project instructions" }, { id: "create" }))
    await Effect.runPromise(Deferred.await(written))
    expect(listings).toHaveLength(1)
    expect(instructionRuns).toBe(1)
    expect(projectRuns).toBe(1)
    expect(listings[0]).toContain("./a.txt")
    expect(listings[0]).not.toContain("./b.txt")
    expect(operations).toEqual(["list"])
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined))
    const third = await Effect.runPromise(Deferred.await(paused))
    expect(operations).toEqual(["list", "write-finished", "list", "list"])
    expect(listings).toHaveLength(3)
    expect(instructionRuns).toBe(3)
    expect(projectRuns).toBe(3)
    const firstSystem = systemBlocks(requests[0]!)
    const secondSystem = systemBlocks(requests[1]!)
    const thirdSystem = systemBlocks(third)
    expect(firstSystem).toHaveLength(5)
    expect(firstSystem.slice(0, 2).map(block => block.text)).toEqual(["Maintain the workspace.", "Follow project instructions."])
    expect(firstSystem[2]?.text).toContain("Project instructions:")
    expect(firstSystem[3]?.text).toContain("Keep changes small.")
    expect(firstSystem[4]?.text).toContain(DEFAULT_WORKSPACE_SYSTEM)
    expect(JSON.stringify(secondSystem)).toBe(JSON.stringify(firstSystem))
    expect(JSON.stringify(thirdSystem.slice(0, 2))).toBe(JSON.stringify(firstSystem.slice(0, 2)))
    expect(thirdSystem[3]?.text).toContain("Use explicit names.")
    expect(thirdSystem[4]).toEqual(firstSystem[4])
    expect(userText(requests[0]!)).not.toContain("./b.txt")
    expect(userText(requests[1]!)).toContain("./b.txt")
    expect(userText(third)).not.toContain("./c.txt")
    const before = await Effect.runPromise(thread.records())
    const snapshots = before.flatMap(record => record.event.type === "ContextResolved" ? [record.event] : [])
    const calls = before.flatMap(record => record.event.type === "ModelCalled" && record.event.purpose === "inference" ? [record.event] : [])
    expect(snapshots.map(event => ({ turnId: event.turnId, callId: event.callId }))).toEqual(calls.map(event => ({ turnId: event.turnId, callId: event.callId })))
    expect(snapshots).toHaveLength(3)
    const projectSnapshot = snapshots[2]!.system.libraries.find(library => library.library === "project")?.content
    expect(projectSnapshot).toEqual([
      expect.objectContaining({ text: "Project instructions:" }),
      expect.objectContaining({ text: "Use explicit names.", options: { fixture: { source: "project" } } }),
    ])
    expect(before.findIndex(record => record.event.type === "ContextResolved" && record.event.callId === calls[2]!.callId))
      .toBeGreaterThan(before.findLastIndex(record => record.event.type === "ToolReturned"))
    const coordinate = thread.coordinate
    await Effect.runPromise(runtime.close)
    await writeFile(join(directory, "c.txt"), "C")
    await writeFile(join(directory, "PROJECT.md"), "Changes made while offline.")
    pause = false
    runtime = await Effect.runPromise(open())
    const restored = await Effect.runPromise(runtime.getThread(coordinate))
    expect(restored).toBeDefined()
    thread = restored!
    expect(await Effect.runPromise(thread.result("message", "create"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(requests).toHaveLength(4)
    expect(JSON.stringify(requests[3])).toBe(JSON.stringify(third))
    expect(listings).toHaveLength(3)
    expect(instructionRuns).toBe(3)
    expect(projectRuns).toBe(3)
    await Effect.runPromise(thread.invoke("message", { text: "Inspect again" }, { id: "inspect" }))
    expect(await Effect.runPromise(thread.result("message", "inspect"))).toEqual({ status: "completed", output: { text: "ok" } })
    expect(listings).toHaveLength(4)
    expect(instructionRuns).toBe(4)
    expect(projectRuns).toBe(4)
    expect(requests).toHaveLength(5)
    expect(userText(requests[4]!)).toContain("./c.txt")
    expect(systemBlocks(requests[4]!)[3]?.text).toContain("Changes made while offline.")
    expect(systemBlocks(requests[4]!).slice(0, 2)).toEqual(firstSystem.slice(0, 2))
    const expectedSystemCheckpoints = caching === "disabled" ? [] : caching === "manual" || caching === "bounded" ? [1] : [1, 3, 4]
    for (const request of requests) {
      expect(systemBlocks(request).flatMap((block, index) => controlled(block) ? [index] : [])).toEqual(expectedSystemCheckpoints)
      const conversationBlocks = (request.input ?? request.messages ?? []).filter(message => message.role !== "system" && message.role !== "developer")
        .flatMap(message => typeof message.content === "string" ? [] : message.content ?? [])
      const hasTailCheckpoint = provider !== "openai" && (caching === "automatic" || caching === "bounded")
      expect(conversationBlocks.flatMap((block, index) => controlled(block) ? [index] : []))
        .toEqual(hasTailCheckpoint ? [conversationBlocks.length - 1] : [])
      if (hasTailCheckpoint) expect(conversationBlocks.at(-1)?.text).toContain(request === requests[4] ? "./c.txt" : request === requests[0] ? "./a.txt" : "./b.txt")
      if (caching === "manual" && provider !== "openai") expect(systemBlocks(request)[1]?.cache_control?.ttl).toBe("1h")
    }
    const after = await Effect.runPromise(thread.records())
    expect(after.filter(record => record.event.type === "ContextResolved")).toHaveLength(4)
  } finally {
    await Effect.runPromise(Deferred.succeed(releaseWrite, undefined))
    await Effect.runPromise(runtime.close)
    await rm(root, { recursive: true, force: true })
  }
})
}
}

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
