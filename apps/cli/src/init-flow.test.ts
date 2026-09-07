import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { makeActorClient } from "@clavia/tardigrade-client"
import { tdg } from "./commands"
import { Cli } from "./services"

const repository = new URL("../../../", import.meta.url).pathname
const namespaces: Readonly<Record<string, string>> = {
  core: "packages/core/src/index.ts", agent: "packages/agent/src/index.ts", code: "packages/code/src/index.ts",
  http: "platform/http/src/http.ts", bun: "platform/bun/src/index.ts", model: "platform/model/src/model.ts", server: "apps/server/src/index.ts"
}

// bundleServer resolves the public package namespaces against their publish sources.
const bundleServer = async (directory: string) => {
  const packed = process.env.TARDIE_TEST_PACKAGE
  const exports = packed === undefined ? undefined : (await Bun.file(join(packed, "package.json")).json() as { exports: Record<string, string> }).exports
  const built = await Bun.build({
    entrypoints: [join(directory, "server.ts")], target: "bun", outdir: join(directory, "build"),
    plugins: [{ name: "workspace-public-package", setup(build) {
      build.onResolve({ filter: /^tardie(?:\/|$)/ }, ({ path }) => {
        if (packed !== undefined && exports !== undefined) {
          const key = path === "tardie" ? "." : `.${path.slice("tardie".length)}`
          const exact = exports[key]
          if (exact !== undefined) return { path: join(packed, exact) }
          const wildcard = Object.keys(exports).find((entry) => entry.endsWith("/*") && key.startsWith(entry.slice(0, -1)))
          if (wildcard === undefined) throw new Error(`missing published export: ${path}`)
          return { path: join(packed, exports[wildcard]!.replace("*", key.slice(wildcard.length - 1))) }
        }
        const [, namespace, ...tail] = path.split("/")
        const entry = namespaces[namespace!]
        if (entry === undefined) return
        const source = tail.length === 0 ? entry : entry.replace(/[^/]+$/, `${tail.join("/")}.ts`)
        return { path: join(repository, source) }
      })
    } }]
  }).catch((error: unknown) => { throw new Error(error instanceof AggregateError ? error.errors.map(String).join("\n") : String(error)) })
  if (!built.success) throw new AggregateError(built.logs, "generated server did not build")
}

const eventually = async (check: () => Promise<boolean>, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("quickstart condition did not complete before its deadline")
}

test("init, serve, discover, call, inspect, cancel, and restart a generated quickstart", async () => {
  const root = await mkdtemp(join(repository, ".cli-flow-"))
  let modelCalls = 0
  let hold = false
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/catalog") return Response.json({ fixture: {
      id: "fixture", name: "Fixture", api: `${model.url}v1`, env: ["FIXTURE_KEY"], models: {
        test: { id: "test", name: "Test", tool_call: true, limit: { context: 32_000, output: 4096 }, modalities: { input: ["text"], output: ["text"] } }
    } } })
    modelCalls++
    if (hold) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(": waiting\n\n")) } }), { headers: { "content-type": "text/event-stream" } })
    const body = await request.json() as { messages: Array<{ role: string }> }
    if (!body.messages.some((message) => message.role === "tool")) return new Response([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "weather", type: "function", function: { name: "get_weather", arguments: "{}" } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    return new Response('data: {"choices":[{"delta":{"content":"Hello from the fixture."},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
  } })
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() })
  const port = reservation.port!
  await reservation.stop(true)
  const url = `http://127.0.0.1:${port}`
  const env = { PATH: process.env.PATH!, PORT: String(port), FIXTURE_KEY: "fixture-secret", TARDIGRADE_MODEL_CATALOG_URL: `${model.url}catalog`, TARDIGRADE_TOKEN: "fixture-token" }
  let cwd = root
  const run = async (...args: string[]) => {
    const lines: string[] = []
    const capture: Console.Console = Object.assign(Object.create(console), { log: (...values: unknown[]) => { lines.push(values.map(String).join(" ")) } })
    await Command.runWith(tdg, { version: "test", renderErrors: false })(args).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Cli, {
        cwd, env, openClient: makeActorClient, fetch: globalThis.fetch,
        installProject: bundleServer, mintId: () => crypto.randomUUID()
      }))), Effect.runPromise
    )
    return lines.join("\n")
  }
  const remote = (...args: string[]) => run(...args, "--url", url, "--token", "fixture-token", "--json")
  let child: ReturnType<typeof Bun.spawn> | undefined
  let stderr: Promise<string> | undefined
  const start = async () => {
    const started = Bun.spawn([process.execPath, "build/server.js"], { cwd, env, stdout: "ignore", stderr: "pipe" })
    child = started
    stderr = new Response(started.stderr).text()
    await eventually(async () => {
      if (child!.exitCode !== null) throw new Error(await stderr)
      return fetch(`${url}/healthz`).then((r) => r.ok, () => false)
    })
  }
  const stop = async () => { child?.kill("SIGTERM"); if (child) expect(await child.exited).toBe(0); child = undefined }
  try {
    await run("init", "tardie-agent", "--provider", "fixture", "--provider-config", JSON.stringify({ protocol: "openai-chat-completions", baseUrl: `${model.url}v1`, env: ["FIXTURE_KEY"] }), "--default-model", "test", "--json")
    cwd = join(root, "tardie-agent")
    expect(await readFile(join(cwd, "worker.ts"), "utf8")).toContain("createWorker")
    await run("lint", "actor.ts", "--json")
    expect(JSON.parse(await run("build", join(cwd, "actor.ts"), "--out", join(cwd, "artifact"), "--json"))).toMatchObject({ manifest: { name: "tardie-agent" } })
    expect(JSON.parse(await run("models", "lock", "--json"))).toMatchObject({ schema: 1 })
    await start()
    const cliProcess = Bun.spawn([process.execPath, join(repository, "apps/cli/src/main.ts"), "methods", "--url", url, "--token", "fixture-token", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const [cliOutput, cliError, cliCode] = await Promise.all([new Response(cliProcess.stdout).text(), new Response(cliProcess.stderr).text(), cliProcess.exited])
    expect(cliError).toBe("")
    expect(cliCode).toBe(0)
    expect(JSON.parse(cliOutput)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "message" })]))
    const client = makeActorClient({ baseUrl: url, token: "fixture-token" })
    expect(await client.metadata()).toMatchObject({ name: "tardie-agent", storage: { kind: "sqlite" } })
    expect(JSON.parse(await remote("methods"))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "message", cancellable: true })]))
    expect(JSON.parse(await remote("providers", "--search", "fixture"))).toMatchObject({ total: 1 })
    expect(JSON.parse(await remote("models"))).toMatchObject({ total: 1 })
    expect(JSON.parse(await remote("thread", "create", "--name", "main"))).toMatchObject({ thread: "main" })
    const inferenceResponse = await fetch(`${url}/v1/actors/main/threads/main/inference/stream`, { headers: { authorization: "Bearer fixture-token" }, signal: AbortSignal.timeout(15_000) })
    expect(inferenceResponse.headers.get("content-type")).toContain("text/event-stream")
    const inferenceReader = inferenceResponse.body!.getReader()
    const completed = JSON.parse(await remote("call", "message", '{"text":"Hello"}', "--thread", "main", "--id", "hello", "--poll", "10"))
    expect(completed).toMatchObject({ status: "completed", output: "Hello from the fixture." })
    let inferenceText = ""
    while (!inferenceText.includes("Hello from the fixture.")) {
      const chunk = await inferenceReader.read()
      if (chunk.done) throw new Error("inference stream ended before its output")
      inferenceText += new TextDecoder().decode(chunk.value)
    }
    await inferenceReader.cancel()
    expect(modelCalls).toBe(2)
    const calls = modelCalls
    expect(JSON.parse(await remote("call", "message", '{"text":"retry"}', "--thread", "main", "--id", "hello"))).toMatchObject({ status: "completed", output: completed.output })
    expect(modelCalls).toBe(calls)
    expect(JSON.parse(await remote("call", "state", "message", "hello", "--thread", "main"))).toMatchObject({ status: "completed" })
    expect(JSON.parse(await remote("ls"))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "main" })]))
    expect(JSON.parse(await remote("events", "main"))).not.toHaveLength(0)
    expect(await client.ensureActor("another")).toMatchObject({ id: "another", definition: "tardie-agent" })
    expect(await client.actors()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "another" })]))
    expect(await client.actor("another")).toMatchObject({ id: "another" })
    const headers = { authorization: "Bearer fixture-token", "content-type": "application/json" }
    const childResponse = await fetch(`${url}/v1/actors/main/threads`, { method: "POST", headers, body: JSON.stringify({ name: "research", parent: "main" }) })
    expect(childResponse.ok).toBe(true)
    expect(await childResponse.json()).toMatchObject({ actor: "tardie-agent", instance: "main", thread: "research" })
    expect((await fetch(`${url}/v1/actors/main/threads/main/tree`, { headers })).status).toBe(200)
    const stream = await fetch(`${url}/v1/actors/main/threads/main/events/stream`, { headers })
    expect(stream.headers.get("content-type")).toContain("text/event-stream")
    const reader = stream.body!.getReader()
    const chunk = await reader.read()
    expect(new TextDecoder().decode(chunk.value)).toContain("data:")
    await reader.cancel()
    const preflight = await fetch(`${url}/v1/actors/main/threads/main/methods/message`, { method: "OPTIONS", headers: { origin: "http://localhost:1234", "access-control-request-method": "POST", "access-control-request-headers": "idempotency-key,content-type" } })
    expect(preflight.headers.get("access-control-allow-headers")).toContain("idempotency-key")
    expect((await fetch(`${url}/v1/methods`)).status).toBe(401)
    expect((await fetch(`${url}/openapi.json`)).status).toBe(200)
    hold = true
    await remote("call", "message", '{"text":"Wait"}', "--thread", "main", "--id", "cancel-me", "--no-wait")
    await eventually(async () => modelCalls > calls)
    await remote("call", "cancel", "message", "cancel-me", "--thread", "main", "--reason", "test cancellation")
    await eventually(async () => JSON.parse(await remote("call", "state", "message", "cancel-me", "--thread", "main")).status === "cancelled")
    await expect(remote("call", "message", '{}', "--thread", "main")).rejects.toThrow()
    await expect(remote("call", "absent", '{}', "--thread", "main")).rejects.toThrow()
    await expect(remote("call", "message", '{}', "--thread", "missing")).rejects.toThrow()
    hold = false
    await stop()
    await start()
    expect(JSON.parse(await remote("call", "message", '{"text":"restart retry"}', "--thread", "main", "--id", "hello"))).toMatchObject({ status: "completed", output: completed.output })
    expect(modelCalls).toBe(calls + 1)
    await stop()
  } finally {
    child?.kill("SIGKILL")
    if (child) await child.exited
    await model.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
