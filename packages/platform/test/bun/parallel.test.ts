import { expect, test } from "bun:test"
import { Context, Effect, Schema } from "effect"
import { parallel, toolsFromLibraries, DEFAULT_PARALLEL_ENDPOINT, DEFAULT_PARALLEL_USER_AGENT, type LibraryFetch } from "@clavia/tardigrade-libraries"
import { defineActor } from "@clavia/tardigrade-core"
import { ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { tools } from "@clavia/tardigrade-agent/atoms/tools"
import { createTestStore } from "../properties/runtime/store"

const input = { objective: "Find Effect documentation", search_queries: ["Effect TypeScript documentation"], session_id: "conversation-test" }
const content = { content: [{ type: "text", text: "Effect documentation: https://effect.website" }] }

function fixture(result: unknown = content) {
  const requests: { url: string; method: string; headers: Headers; message?: { method: string; params?: { name?: string; arguments?: unknown } } }[] = []
  const fetch: LibraryFetch = async (url, init) => {
    const method = init?.method ?? "GET"
    if (!(init?.headers instanceof Headers)) throw new Error("Expected SDK request headers")
    const headers = new Headers(init.headers)
    if (method === "GET") {
      requests.push({ url: String(url), method, headers })
      return new Response(null, { status: 405 })
    }
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } }
    requests.push({ url: String(url), method, headers, message })
    if (message.id === undefined) return new Response(null, { status: 202 })
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : result })
  }
  return { fetch, requests }
}

async function execute(options: Parameters<typeof parallel>[0], name: string, args: Schema.Json) {
  const implementation = parallel(options)
  const actor = defineActor("parallel-test", Effect.map(tools([implementation]), atom => ({ atom })))
  const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog), services: () => toolActs([implementation]) }))
  try {
    expect(store.getState().view.specs.map(spec => spec.name)).toEqual(["parallel__search", "parallel__fetch"])
    await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "call", providerId: "fixture", name, input: args }] }]))
    await Effect.runPromise(store.wait)
    const returned = store.snapshot().events.find(event => event.type === "ToolReturned")
    if (!returned || returned.type !== "ToolReturned") throw new Error("No ToolReturned event")
    return returned
  } finally { await Effect.runPromise(store.close) }
}

test("dispatches anonymous search and fetch through the selected library catalog", async () => {
  const mock = fixture()
  for (const [method, args, remote] of [
    ["search", input, "web_search"],
    ["fetch", { urls: ["https://effect.website"], session_id: input.session_id, full_content: true }, "web_fetch"],
  ] as const) {
    const result = await execute({ fetch: mock.fetch }, `parallel__${method}`, args)
    expect(result.error).toBeNull()
    expect(JSON.parse(result.output)).toEqual(content)
    expect(mock.requests.findLast(request => request.message?.method === "tools/call")?.message?.params).toEqual({ name: remote, arguments: args })
  }
  for (const request of mock.requests) {
    expect(request.url).toBe(DEFAULT_PARALLEL_ENDPOINT)
    expect(request.headers.get("User-Agent")).toBe(DEFAULT_PARALLEL_USER_AGENT)
    expect(request.headers.has("Authorization")).toBe(false)
  }
})

test("rejects invalid arguments before making a request and surfaces MCP errors", async () => {
  const mock = fixture({ ...content, isError: true })
  expect((await execute({ fetch: mock.fetch }, "parallel__search", { ...input, search_queries: [] })).error).not.toBeNull()
  expect((await execute({ fetch: mock.fetch }, "parallel__fetch", { urls: ["file:///secret"] })).error).not.toBeNull()
  expect(mock.requests).toHaveLength(0)
  expect((await execute({ fetch: mock.fetch }, "parallel__search", input)).error).toContain("Effect documentation")
})

test("honors endpoint and User-Agent overrides", async () => {
  const mock = fixture()
  const selected = toolsFromLibraries([parallel({ fetch: mock.fetch, endpoint: "https://fixture.test/mcp", userAgent: "tardigrade-test", timeoutMs: 1234 })])[0]!
  await execute({ fetch: mock.fetch, endpoint: "https://fixture.test/mcp", userAgent: "tardigrade-test", timeoutMs: 1234 }, selected.spec.name, input)
  expect(selected.spec.description).toContain("1234ms")
  expect(mock.requests.every(request => request.url === "https://fixture.test/mcp" && request.headers.get("User-Agent") === "tardigrade-test")).toBe(true)
  expect(() => parallel({ timeoutMs: 0 })).toThrow("positive safe integer")
  expect(() => parallel({ endpoint: "file:///secret" })).toThrow("HTTP or HTTPS")
})

test("aborts tool HTTP requests when the complete call times out or the actor closes", async () => {
  for (const interrupted of [false, true]) {
    let requestSignal: AbortSignal | undefined
    let started: (() => void) | undefined
    const ready = new Promise<void>(resolve => { started = resolve })
    const mock = fixture()
    const fetch: LibraryFetch = (url, init) => {
      const message = typeof init?.body === "string" ? JSON.parse(init.body) as { method: string } : undefined
      if (message?.method !== "tools/call") return mock.fetch(url, init)
      return new Promise((_resolve, reject) => {
        const signal = init?.signal ?? undefined
        requestSignal = signal
        started?.()
        if (signal?.aborted) { reject(new Error("aborted")); return }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    }
    const implementation = parallel({ fetch, timeoutMs: interrupted ? 10000 : 1000 })
    const actor = defineActor("parallel-cancel", Effect.map(tools([implementation]), atom => ({ atom })))
    const store = await Effect.runPromise(createTestStore({ actor, actorContext: Context.pick(ToolCatalog), services: () => toolActs([implementation]) }))
    try {
      await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "cancel", providerId: "fixture", name: "parallel__search", input }] }]))
      await ready
      if (interrupted) await Effect.runPromise(store.close)
      else {
        await Effect.runPromise(store.wait)
        expect(store.snapshot().events.find(event => event.type === "ToolReturned")).toMatchObject({ error: expect.stringContaining("Timeout") })
      }
      expect(requestSignal?.aborted).toBe(true)
    } finally { await Effect.runPromise(store.close) }
  }
}, 15000)
