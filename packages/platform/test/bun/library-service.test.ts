import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { RpcTest } from "effect/rpc"
import { tools } from "@clavia/tardigrade-agent/atoms/tools"
import { codeMode } from "@clavia/tardigrade-agent/atoms/code-mode"
import { ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { Event } from "@clavia/tardigrade-agent/contracts/code-mode"
import { agentServices, toolActs } from "@clavia/tardigrade-agent/services/tools"
import { codeModeActs } from "@clavia/tardigrade-agent/services/code-mode"
import { defineActor } from "@clavia/tardigrade-core"
import { createBunHost, bunIsolate, bunJournal, virtualWorkspace } from "../../src/bun"
import { Notebook, notebook, references, notebookLayer } from "../fixtures/library-service"
import { agent } from "@clavia/tardigrade-agent/agent"
import { actorContext } from "@clavia/tardigrade-agent/actor/context"
import { contentModelServices } from "../fixtures/agent"
import { createTestStore } from "../properties/runtime/store"

test("ordinary service layers back distinct library views and durable agent tools", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-library-service-"))
  const backend = virtualWorkspace({ name: "notes", filename: join(directory, "workspace.sqlite") })
  const layer = notebookLayer(backend)
  const program: Effect.Effect<string, string, Notebook> = Effect.gen(function* () {
    const notes = yield* Notebook
    yield* notes.write({ path: "research.md", text: "A journal is durable evidence." })
    return yield* notes.read({ path: "research.md" })
  })
  const supplied: Effect.Effect<string, Error | string> = program.pipe(Effect.provide(layer))
  const libraries = [notebook, references] as const
  const actor = defineActor("notes-tools", Effect.map(tools(libraries), atom => ({ atom, schema: Event })))
  const open = () => Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog),
    journal: bunJournal<typeof Event.Type>({ filename: join(directory, "journal.sqlite"), actor: "events" }),
    services: () => toolActs(libraries).pipe(Layer.provide(layer)),
  }))
  let store: Awaited<ReturnType<typeof open>> | undefined
  try {
    assert.equal(await Effect.runPromise(supplied), "A journal is durable evidence.")
    const native = Effect.scoped(Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(notebook.library.methods)
      return yield* client.read({ path: "research.md" })
    })).pipe(Effect.provide(notebook.library.methods.toLayer(Notebook).pipe(Layer.provide(layer))))
    assert.equal(await Effect.runPromise(native), "A journal is durable evidence.")
    store = await open()
    assert.deepEqual(store.getState().view.specs.find(spec => spec.name === "read_note")?.annotations, { readOnlyHint: true, openWorldHint: false })
    const submit = (id: string, name: string, input: { readonly path: string; readonly text?: string }) => store!.send([
      { type: "ModelReturned", purpose: "inference", turnId: id, callId: `model:${id}`, text: "", toolCalls: [{ callId: id, providerId: id, name, input }] },
    ]).pipe(Effect.andThen(store!.wait))
    await Effect.runPromise(submit("read", "read_note", { path: "research.md" }))
    await Effect.runPromise(submit("write", "write_note", { path: "research.md", text: "Tool writes reach the same service." }))
    const read = store.snapshot().events.find(event => event.type === "ToolReturned" && event.callId === "read")
    assert.ok(read?.type === "ToolReturned" && read.error === null)
    assert.deepEqual(read.content, [{ type: "text", text: '"A journal is durable evidence."' }])
    assert.equal(await Effect.runPromise(Notebook.use(notes => notes.read({ path: "research.md" })).pipe(Effect.provide(layer))), "Tool writes reach the same service.")
    const count = store.snapshot().position
    await Effect.runPromise(store.close)
    store = await open()
    assert.equal(store.snapshot().position, count)
    await Effect.runPromise(submit("alias", "notes__read", { path: "research.md" }))
    await Effect.runPromise(submit("reference", "read_reference", { path: "research.md" }))
    await Effect.runPromise(submit("reference-write", "references__write", { path: "research.md", text: "This projection cannot write." }))
    await Effect.runPromise(submit("invalid", "read_note", { path: "" }))
    const events = store.snapshot().events
    const alias = events.find(event => event.type === "ToolReturned" && event.callId === "alias")
    assert.ok(alias?.type === "ToolReturned" && alias.error === null)
    assert.deepEqual(alias.content, [{ type: "text", text: '"Tool writes reach the same service."' }])
    const reference = events.find(event => event.type === "ToolReturned" && event.callId === "reference")
    assert.ok(reference?.type === "ToolReturned" && reference.error === null)
    assert.deepEqual(reference.content, [{ type: "text", text: '"Tool writes reach the same service."' }])
    const deniedWrite = events.find(event => event.type === "ToolReturned" && event.callId === "reference-write")
    assert.ok(deniedWrite?.type === "ToolReturned" && deniedWrite.error !== null)
    assert.equal(await Effect.runPromise(Notebook.use(notes => notes.read({ path: "research.md" })).pipe(Effect.provide(layer))), "Tool writes reach the same service.")
    const invalid = events.find(event => event.type === "ToolReturned" && event.callId === "invalid")
    assert.ok(invalid?.type === "ToolReturned" && invalid.error !== null)
  } finally {
    if (store) await Effect.runPromise(store.close)
    await rm(directory, { recursive: true, force: true })
  }
})

test("an ordinary service runs through a real code isolate with its supplied layer", async () => {
  const layer = notebookLayer(virtualWorkspace({ name: "notes", filename: ":memory:" }))
  const actor = defineActor("notes-code", Effect.map(codeMode([notebook]), atom => ({ atom, schema: Event })))
  const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog), services: () => codeModeActs([notebook]).pipe(Layer.provideMerge(Layer.merge(layer, bunIsolate()))) }))
  try {
    await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "code-model", text: "", toolCalls: [{ callId: "code", providerId: "code", name: "execute", input: {
      code: 'await notes.write({ path: "result.md", text: "One service, two callers." }); return await notes.read({ path: "result.md" });',
    } }] }]))
    await Effect.runPromise(store.wait)
    const result = store.snapshot().events.find(event => event.type === "ToolReturned" && event.callId === "code")
    assert.ok(result?.type === "ToolReturned" && result.error === null)
    const output = JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join("\n")) as { result: string }
    assert.equal(output.result, "One service, two callers.")
  } finally { await Effect.runPromise(store.close) }
})

test("a host derives library adapters for an ordinary service and recovers its SQLite writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-agent-requirements-"))
  const assistant = agent({ name: "researcher", system: "Record research notes.", tools: [notebook] })
  const backend = notebookLayer(virtualWorkspace({ name: "notes", filename: join(directory, "workspace.sqlite") }))
  let modelCalls = 0
  const models = contentModelServices(() => { modelCalls++ }, { toolCalls: [
    { id: "write", name: "write_note", params: { path: "research.md", text: "Written through the agent's declared capability." } },
  ] })
  const open = () => Effect.runPromise(createBunHost({
    actor: assistant, actorContext, storage: join(directory, "agent"),
    services: () => agentServices(assistant).pipe(Layer.provideMerge(Layer.merge(models, backend))),
  }))
  let host: Awaited<ReturnType<typeof open>> | undefined
  try {
    host = await open()
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "research" }))
    await Effect.runPromise(thread.invoke("message", { text: "Record a finding." }, { id: "first" }))
    await Effect.runPromise(thread.wait)
    assert.deepEqual(await Effect.runPromise(thread.methodState("message", "first")), { status: "completed", output: { text: "ok" } })
    const records = await Effect.runPromise(thread.records())
    const writes = records.filter(record => record.event.type === "ToolReturned" && record.event.tool?.name === "write_note")
    assert.equal(writes.length, 1)
    assert.ok(writes[0]?.event.type === "ToolReturned" && writes[0].event.error === null)
    assert.equal(await Effect.runPromise(Notebook.use(notes => notes.read({ path: "research.md" })).pipe(Effect.provide(backend))), "Written through the agent's declared capability.")
    const callsBeforeReopen = modelCalls
    await Effect.runPromise(host.close)
    host = await open()
    const reopened = await Effect.runPromise(host.getThread(thread.coordinate))
    assert.ok(reopened)
    await Effect.runPromise(reopened.wait)
    assert.equal(modelCalls, callsBeforeReopen)
    assert.deepEqual(await Effect.runPromise(reopened.methodState("message", "first")), { status: "completed", output: { text: "ok" } })
    await Effect.runPromise(reopened.invoke("message", { text: "Continue." }, { id: "second" }))
    await Effect.runPromise(reopened.wait)
    assert.deepEqual(await Effect.runPromise(reopened.methodState("message", "second")), { status: "completed", output: { text: "ok" } })
    assert.equal(modelCalls, callsBeforeReopen + 1)
  } finally {
    if (host) await Effect.runPromise(host.close)
    await rm(directory, { recursive: true, force: true })
  }
})
