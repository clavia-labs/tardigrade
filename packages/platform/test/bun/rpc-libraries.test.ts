import { describe, expect, test } from "bun:test"
import { Context, Effect, JsonSchema, Layer, Schema, SchemaRepresentation } from "effect"
import { Tool as AiTool } from "effect/unstable/ai"
import { Validator } from "@cfworker/json-schema"
import { Rpc, RpcTest } from "effect/unstable/rpc"
import { defineLibrary, MethodDescription, MethodExecution, MethodHints, toolsFromLibraries } from "@clavia/tardigrade-libraries"
import { arxiv, workspace, memoryWorkspace } from "@clavia/tardigrade-libraries"
import { ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { codeModeActs } from "@clavia/tardigrade-agent/services/code-mode"
import { tools } from "@clavia/tardigrade-agent/atoms/tools"
import { defineActor, Isolate } from "@clavia/tardigrade-core"
import { codeMode } from "@clavia/tardigrade-agent/atoms/code-mode"
import { bunIsolate } from "@clavia/tardigrade-platform/bun"
import { Event } from "@clavia/tardigrade-agent/contracts/code-mode"

import { createTestStore } from "../properties/runtime/store"
import { type LibraryImplementation } from "@clavia/tardigrade-libraries"
import { tool, promiseTool } from "@clavia/tardigrade-libraries"

const call = { callId: "read", name: "notes__read", input: { key: "paper" } }
const notes = defineLibrary({ name: "notes", description: "Research notes", methods: [
  Rpc.make("read", { payload: Schema.Struct({ key: Schema.String }), success: Schema.String, error: Schema.String })
    .annotate(MethodDescription, "Read a note")
    .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
] })


async function invoke(implementation: LibraryImplementation<import("@clavia/tardigrade-core").EffectExecution>, input: Schema.Json, name = call.name) {
  const actor = defineActor("library-test", Effect.map(tools(), atom => ({ atom })))
  const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog), services: () => toolActs([implementation]) }))
  try {
    await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: call.callId, providerId: "provider", name, input }] }]))
    await Effect.runPromise(store.wait)
    const result = store.snapshot().events.find(event => event.type === "ToolReturned")
    if (!result || result.type !== "ToolReturned") throw new Error("No library result recorded")
    return result
  } finally { await Effect.runPromise(store.close) }
}

describe("RPC libraries", () => {
  test("named and nested schemas survive library export and model tool import", () => {
    const Place = Schema.Struct({ city: Schema.String }).annotate({ identifier: "Place/~% café" })
    const Input = Schema.Struct({ place: Place }).annotate({ identifier: "SearchInput" })
    const Output = Schema.Struct({ result: Place }).annotate({ identifier: "SearchOutput" })
    const library = defineLibrary({ name: "named", description: "", methods: [
      Rpc.make("search", { payload: Input, success: Output }),
    ] })
    const foreground = tool({ name: "direct", description: "", input: Input, run: () => Effect.succeed(null) })
    const background = promiseTool({ name: "background", description: "", input: Input, submit: () => Effect.succeed({ executor: "test", id: "job" }) })
    for (const spec of [library.specs[0]!, foreground.spec, background.spec]) {
      const exported = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(spec.inputSchema)
      expect(exported.type).toBe("object")
      const validator = new Validator(exported)
      expect(validator.validate({ place: { city: "Singapore" } }).valid).toBe(true)
      expect(validator.validate({ place: { city: 42 } }).valid).toBe(false)
      const imported = SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft07(exported))
      const modelTool = AiTool.dynamic(spec.name, { description: spec.description, parameters: Schema.toEncoded(imported) })
      const providerSchema = AiTool.getJsonSchema(modelTool)
      const providerValidator = new Validator(providerSchema, "2020-12")
      expect(providerValidator.validate({ place: { city: "Singapore" } }).valid).toBe(true)
      expect(providerValidator.validate({ place: { city: 42 } }).valid).toBe(false)
    }
    const output = new Validator(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(library.specs[0]!.outputSchema))
    expect(output.validate({ result: { city: "Singapore" } }).valid).toBe(true)
    expect(output.validate({ result: { city: 42 } }).valid).toBe(false)
  })

  test("recursive library schemas retain their local references", () => {
    interface Tree { readonly value: string; readonly children: readonly Tree[] }
    const Tree: Schema.Codec<Tree> = Schema.Struct({ value: Schema.String, children: Schema.Array(Schema.suspend(() => Tree)) }).annotate({ identifier: "Tree" })
    const library = defineLibrary({ name: "trees", description: "", methods: [
      Rpc.make("read", { payload: Schema.Struct({ tree: Tree }).annotate({ identifier: "TreeInput" }), success: Tree }),
    ] })
    const valid = { value: "root", children: [{ value: "leaf", children: [] }] }
    const invalid = { value: "root", children: [{ value: 42, children: [] }] }
    const input = new Validator(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(library.specs[0]!.inputSchema))
    const output = new Validator(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(library.specs[0]!.outputSchema))
    expect(input.validate({ tree: valid }).valid).toBe(true)
    expect(input.validate({ tree: invalid }).valid).toBe(false)
    expect(output.validate(valid).valid).toBe(true)
    expect(output.validate(invalid).valid).toBe(false)
  })

  test("shares a typed declaration with a native Effect RPC client", async () => {
    const read = ({ key }: { key: string }) => Effect.succeed(`Note: ${key}`)
    const implementation = notes.implement({ read })
    const [native, adapted] = await Promise.all([
      Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(notes.methods)
        return yield* client.read({ key: "paper" })
      }).pipe(Effect.provide(notes.methods.toLayer({ read }))))),
      invoke(implementation, call.input),
    ])
    expect(adapted.error).toBeNull()
    expect(JSON.parse(adapted.output)).toBe(native)
    const spec = toolsFromLibraries([implementation])[0]!.spec
    expect(spec.annotations).toEqual({ readOnlyHint: true, openWorldHint: false })
    expect(spec.outputSchema).toMatchObject({ type: "string" })
  })

  test("validates payloads before calling handlers and validates encoded results", async () => {
    let calls = 0
    const implementation = notes.implement({ read: () => {
      calls++
      return Effect.succeed(42 as unknown as string)
    } })
    expect((await invoke(implementation, { key: 42 })).error).not.toBeNull()
    expect(calls).toBe(0)
    expect((await invoke(implementation, call.input)).error).not.toBeNull()
    expect(calls).toBe(1)
  })

  test("supports empty RPC payloads and encodes transformed successes", async () => {
    const typed = defineLibrary({ name: "typed", description: "", methods: [
      Rpc.make("number", { success: Schema.FiniteFromString }),
      Rpc.make("clear"),
    ] }).implement({ number: () => Effect.succeed(42), clear: () => Effect.void })
    expect(JSON.parse((await invoke(typed, {}, "typed__number")).output)).toBe("42")
    expect(JSON.parse((await invoke(typed, {}, "typed__clear")).output)).toBeNull()
  })

  test("retains structured RPC errors in tool failures", async () => {
    const typed = defineLibrary({ name: "typed", description: "", methods: [
      Rpc.make("read", { payload: Schema.Struct({}), success: Schema.String, error: Schema.Struct({ code: Schema.String }) }),
    ] }).implement({ read: () => Effect.fail({ code: "missing" }) })
    expect((await invoke(typed, {}, "typed__read")).error).toContain('"code":"missing"')
  })

  test("rejects duplicate method names, conflicting aliases, and unsupported RPC modes", () => {
    const rpc = Rpc.make("read", { payload: Schema.Struct({}), success: Schema.String })
    expect(() => defineLibrary({ name: "notes", description: "", methods: [rpc, rpc] })).toThrow("Duplicate method")
    expect(() => defineLibrary({ name: "notes", description: "", methods: [Rpc.make("stream", { payload: Schema.Struct({}), stream: true, success: Schema.String, error: Schema.String })] })).toThrow("unary")
    const implementation = notes.implement({ read: () => Effect.succeed("value") })
    expect(() => toolsFromLibraries([implementation, implementation])).toThrow("Duplicate library")
    expect(() => codeModeActs([defineLibrary({ name: "jobs", description: "", methods: [
      rpc.annotate(MethodExecution, "background"),
    ] }).implement({ read: () => Effect.succeed("value") })])).toThrow("foreground")
  })

  test("selects direct tools from the configured library catalog", async () => {
    const other = defineLibrary({ name: "other", description: "", methods: [
      Rpc.make("read", { payload: Schema.Struct({}), success: Schema.String }),
    ] }).implement({ read: () => Effect.succeed("other") })
    const implementation = notes.implement({ read: () => Effect.succeed("note") })
    const actor = defineActor("selected", Effect.map(tools([notes]), atom => ({ atom })))
    const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog), services: () => toolActs([implementation, other]) }))
    try {
      expect(store.getState().view.specs.map(spec => spec.name)).toEqual(["notes__read"])
      expect(store.getState().view.prepare({ callId: "other", providerId: "provider", name: "other__read", input: {} })).toEqual({ position: "ready", counted: false, error: "Unknown tool: other__read" })
    } finally { await Effect.runPromise(store.close) }
  })

  test("code mode uses selected namespaces and preserves method annotations", async () => {
    const implementation = notes.implement({ read: () => Effect.succeed("note") })
    const other = defineLibrary({ name: "other", description: "", methods: [
      Rpc.make("read", { payload: Schema.Struct({}), success: Schema.String }),
    ] }).implement({ read: () => Effect.succeed("other") })
    let namespaces: string[] = []
    const actor = defineActor("selected-code", Effect.map(codeMode([notes]), atom => ({ atom, schema: Event })))
    const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog),
      services: () => codeModeActs([implementation, other]).pipe(Layer.provideMerge(Layer.succeed(Isolate, {
        run: (input, onCall) => {
          namespaces = Object.keys(input.packages)
          return onCall({ ordinal: 0, package: "notes", method: "read", input: call.input }).pipe(Effect.map(result => ({ result, logs: [] })))
        },
      }))),
    }))
    try {
      expect(store.getState().view.system).toContain("notes.read")
      expect(store.getState().view.system).not.toContain("other.read")
      expect(store.getState().view.specs[0]!.annotations?.readOnlyHint).toBe(true)
      await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "code", providerId: "provider", name: "execute", input: { code: 'return await notes.read({ key: "paper" })' } }] }]))
      await Effect.runPromise(store.wait)
      expect(namespaces).toEqual(["notes"])
      expect(store.snapshot().events.find(event => event.type === "ToolReturned" && event.callId === "code")).toMatchObject({ output: '{"result":"note","logs":[]}', error: null })
    } finally { await Effect.runPromise(store.close) }
  })

  test("runs arXiv and workspace methods through a real Bun code isolate", async () => {
    const libraries = [arxiv({ fetch: async () => new Response("<feed><entry><title>Durable agents</title></entry></feed>") }), workspace()]
    const actor = defineActor("research", Effect.map(codeMode(libraries), atom => ({ atom, schema: Event })))
    const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog),
      services: () => codeModeActs(libraries).pipe(Layer.provideMerge(Layer.merge(bunIsolate(), memoryWorkspace))),
    }))
    try {
      const code = 'const papers = await arxiv.search({ query: "all:agents", maxResults: 1 }); await workspace.write({ key: "research", value: papers.feed }); return await workspace.read({ key: "research" });'
      await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "research", providerId: "provider", name: "execute", input: { code } }] }]))
      await Effect.runPromise(store.wait.pipe(Effect.timeout(5_000)))
      const returned = store.snapshot().events.find(event => event.type === "ToolReturned" && event.callId === "research")
      expect(returned).toMatchObject({ error: null })
      if (!returned || returned.type !== "ToolReturned") throw new Error("Research result was not recorded")
      expect(JSON.parse(returned.output).result.value).toContain("Durable agents")
      expect(store.snapshot().events.filter(event => event.type === "MethodRequested").map(event => `${event.package}.${event.method}`)).toEqual(["arxiv.search", "workspace.write", "workspace.read"])
    } finally { await Effect.runPromise(store.close) }
  })

  test("arXiv exposes pagination overrides and returns the research feed", async () => {
    let requested: URL | undefined
    const implementation = arxiv({ maxResults: 3, fetch: async input => {
      requested = new URL(String(input))
      return new Response('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Agent research</title></entry></feed>')
    } })
    const result = await invoke(implementation, { query: "all:agents", maxResults: 8, start: 2 }, "arxiv__search")
    expect(requested?.searchParams.get("max_results")).toBe("8")
    expect(requested?.searchParams.get("start")).toBe("2")
    expect(result.error).toBeNull()
    expect(JSON.parse(result.output)).toMatchObject({ query: "all:agents", maxResults: 8, start: 2, feed: expect.stringContaining("Agent research") })
  })
})
