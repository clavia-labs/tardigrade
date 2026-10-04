import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Validator } from "@cfworker/json-schema"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { createBunHost, methodHttp } from "@clavia/tardigrade-platform/bun"
import { Generate, requestBudget } from "@clavia/tardigrade-agent"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

test("HTTP discovers and invokes actor-owned methods without opening a durable thread", async () => {
  class ContractName extends Context.Service<ContractName, string>()("test/ContractName") {}
  const Added = event({ type: "Added", amount: Schema.Finite })
  const External = act({ name: "test.external", input: Schema.Null, success: Schema.Null, failure: Schema.String })
  let executions = 0
  let recoveries = 0
  let releases = 0
  const count = durableAtom({ name: "http.count", input: Added, schema: Schema.Finite, initial: 0, reduce: (state, event) => state + event.amount })
  const actor = defineActor("counter", Effect.gen(function* () {
    const name = yield* ContractName
    const request = External.request({ input: null })
    return {
      atom: effectAtom(get => ({ view: get(count), events: {}, acts: { external: request } })),
      methods: {
        [name]: actorMethod({ inputSchema: Schema.Finite, outputSchema: Schema.Finite,
          onReceive: Added.from(amount => ({ amount })), result: (_, get) => ({ status: "completed", output: get(count) }),
        }),
      },
    }
  }))
  const storage = await mkdtemp(join(tmpdir(), "tardie-method-http-"))
  directories.push(storage)
  const host = await Effect.runPromise(createBunHost({
    actor, storage, actorContext: Context.pick(ContractName),
    services: (_, runtime) => Layer.mergeAll(
      Layer.effect(ContractName, Effect.acquireRelease(Effect.succeed("increase"), () => Effect.sync(() => { releases++ }))),
      External.layer(() => Effect.sync(() => { executions++; return null })),
      Layer.effectDiscard(runtime.onReady(Effect.sync(() => { recoveries++ }))),
    ),
  }))
  const handler = methodHttp(host)
  const request = (path: string, init?: RequestInit) => handler(new Request(`http://test${path}`, init))
  try {
    const metadata = await request("/v1/methods")
    expect(metadata.status).toBe(200)
    expect(await metadata.json()).toEqual([{ name: "increase", cancellable: false, inputSchema: { type: "number" }, outputSchema: { type: "number" } }])
    expect(executions).toBe(0)
    expect(recoveries).toBe(0)
    expect(releases).toBe(1)
    expect(await readdir(storage)).toEqual([])
    const created = await request("/v1/actors/main/threads", { method: "POST", body: JSON.stringify({ name: "counter" }) })
    expect(created.status).toBe(200)
    const route = "/v1/actors/main/threads/counter/methods/increase"
    expect((await request(route, { method: "POST", headers: { "idempotency-key": "one" }, body: "2" })).status).toBe(202)
    const thread = await Effect.runPromise(host.getThread({ instance: "main", thread: "counter" }))
    await Effect.runPromise(thread!.wait)
    expect(executions).toBe(1)
    expect(recoveries).toBe(1)
    expect(await (await request(`${route}/calls/one`)).json()).toEqual({ id: "one", method: "increase", status: "completed", output: 2 })
    expect((await request(route, { method: "POST", headers: { "idempotency-key": "invalid" }, body: '"bad"' })).status).toBe(400)
    expect((await request("/v1/actors/main/threads/counter/methods/message", { method: "POST", headers: { "idempotency-key": "unknown" }, body: "2" })).status).toBe(404)
  } finally { await Effect.runPromise(host.close) }
  expect(releases).toBe(2)
})

test("HTTP discovery retains named and nested method schemas", async () => {
  const Place = Schema.Struct({ city: Schema.String }).annotate({ identifier: "Place" })
  const Input = Schema.Struct({ place: Place }).annotate({ identifier: "EchoInput" })
  const Output = Schema.Struct({ result: Place }).annotate({ identifier: "EchoOutput" })
  const Received = event({ type: "Received", place: Place })
  const place = durableAtom({ name: "http.place", input: Received, schema: Place, initial: { city: "" }, reduce: (_, event) => event.place })
  const actor = defineActor("echo", Effect.succeed({
    atom: effectAtom(get => ({ view: get(place), events: {}, acts: {} })),
    methods: { echo: actorMethod({ inputSchema: Input, outputSchema: Output,
      onReceive: Received.from(input => input), result: (_, get) => ({ status: "completed", output: { result: get(place) } }),
    }) },
  }))
  const storage = await mkdtemp(join(tmpdir(), "tardie-method-schemas-"))
  directories.push(storage)
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  const handler = methodHttp(host)
  const request = (path: string, init?: RequestInit) => handler(new Request(`http://test${path}`, init))
  try {
    const response = await request("/v1/methods")
    expect(response.status).toBe(200)
    const metadata = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ inputSchema: Schema.Record(Schema.String, Schema.Json), outputSchema: Schema.Record(Schema.String, Schema.Json) })))(await response.json())
    const input = new Validator(metadata[0]!.inputSchema)
    const output = new Validator(metadata[0]!.outputSchema)
    expect(input.validate({ place: { city: "Singapore" } }).valid).toBe(true)
    expect(input.validate({ place: { city: 42 } }).valid).toBe(false)
    expect(output.validate({ result: { city: "Singapore" } }).valid).toBe(true)
    expect(output.validate({ result: { city: 42 } }).valid).toBe(false)
    expect((await request("/v1/actors/main/threads", { method: "POST", body: JSON.stringify({ name: "echo" }) })).status).toBe(200)
    const route = "/v1/actors/main/threads/echo/methods/echo"
    expect((await request(route, { method: "POST", headers: { "idempotency-key": "one" }, body: JSON.stringify({ place: { city: "Singapore" } }) })).status).toBe(202)
    const thread = await Effect.runPromise(host.getThread({ instance: "main", thread: "echo" }))
    await Effect.runPromise(thread!.wait)
    const result = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, method: Schema.String, status: Schema.String, output: Schema.Json }))(await (await request(`${route}/calls/one`)).json())
    expect(result).toEqual({ id: "one", method: "echo", status: "completed", output: { result: { city: "Singapore" } } })
    expect(output.validate(result.output).valid).toBe(true)
  } finally { await Effect.runPromise(host.close) }
})

test("budget request specifications can enter a model act", () => {
  const request = Generate.request({ input: {
    model: { provider: "test", model_id: "test" }, system: "", context: [], tools: [requestBudget.spec],
  } })
  expect(request.request.input).toMatchObject({ tools: [{ name: "request_budget", execution: "foreground" }] })
})

