import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Cause, Console, Effect, Layer, Option, Queue, Terminal } from "effect"
import { Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { openCliClient } from "./client"
import { tdg } from "./commands"
import { Cli } from "./services"

const repository = new URL("../../../", import.meta.url).pathname
// bundleEntry resolves the public package namespaces against their publish sources.
const bundleEntry = async (directory: string, entry: "server.ts" | "worker.ts" = "server.ts") => {
  const packed = process.env.TARDIE_TEST_PACKAGE
  const exports = packed === undefined ? undefined : (await Bun.file(join(packed, "package.json")).json() as { exports: Record<string, string> }).exports
  const compiler = `
    const directory = ${JSON.stringify(directory)};
    const entry = ${JSON.stringify(entry)};
    const repository = ${JSON.stringify(repository)};
    const packed = ${JSON.stringify(packed ?? null)};
    const exports = ${JSON.stringify(exports ?? null)};
    const built = await Bun.build({
      entrypoints: [directory + "/" + entry], target: entry === "worker.ts" ? "browser" : "bun", outdir: directory + "/build",
      external: ["cloudflare:workers", ...(entry === "worker.ts" ? ["node:*"] : [])],
      plugins: [{ name: "public-package", setup(build) {
        build.onResolve({ filter: /^tardie(?:\\/|$)/ }, ({ path }) => {
          if (packed && exports) {
            const key = path === "tardie" ? "." : "." + path.slice("tardie".length);
            const exact = exports[key];
            if (exact) return { path: packed + "/" + exact };
            const wildcard = Object.keys(exports).find(entry => entry.endsWith("/*") && key.startsWith(entry.slice(0, -1)));
            if (!wildcard) throw new Error("Missing export: " + path);
            return { path: packed + "/" + exports[wildcard].replace("*", key.slice(wildcard.length - 1)) };
          }
          return { path: Bun.resolveSync(path, repository + "/apps/cli/src") };
        });
      } }],
    });
    if (!built.success) throw new AggregateError(built.logs, "generated entry did not build");
  `
  const child = Bun.spawn([process.execPath, "-e", compiler], { stdout: "pipe", stderr: "pipe" })
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
  if (code !== 0) throw new Error(errors)

}

const eventually = async (check: () => Promise<boolean>, timeout = 10_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("quickstart condition did not complete before its deadline")
}

test.each(["registry", "custom", "interactive"] as const)("generated quickstart lifecycle with %s models", async (source) => {
  const fixtures = join(repository, ".cache", "cli-tests")
  await mkdir(fixtures, { recursive: true })
  const root = await mkdtemp(join(fixtures, "flow-"))
  let modelCalls = 0
  let catalogCalls = 0
  let hold = false
  const model = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request): Promise<Response> {
    if (new URL(request.url).pathname === "/catalog") catalogCalls++
    if (new URL(request.url).pathname === "/catalog" && source !== "registry") return new Response("offline", { status: 503 })
    if (new URL(request.url).pathname === "/catalog") return Response.json({ fixture: {
      id: "fixture", name: "Fixture", api: `${model.url}v1`, env: ["FIXTURE_KEY"], models: {
        test: { id: "test", name: "Test", tool_call: true, limit: { context: 32_000, output: 4096 }, modalities: { input: ["text"], output: ["text"] } }
    } } })
    modelCalls++
    if (hold) await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }))
    const body = await request.json() as { messages: Array<{ role: string }>; stream?: boolean }
    if (new URL(request.url).pathname.endsWith("/messages")) {
      expect(request.headers.get("x-api-key")).toBe("fixture-secret")
      const message = { id: "anthropic-fixture", type: "message", role: "assistant", model: "claude-fixture",
        content: [{ type: "text", text: "Hello from Anthropic." }], stop_reason: "end_turn", stop_sequence: null,
        container: null,
        usage: { input_tokens: 10, output_tokens: 10, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: null, service_tier: "standard" },
      }
      if (!body.stream) return Response.json(message)
      const events = [
        { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Anthropic." } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
    }
    if (!("stream" in body) || !body.stream) {
      const tool = !body.messages.some(message => message.role === "tool")
      return Response.json({ id: "chat-fixture", object: "chat.completion", model: "test", created: 1, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: { role: "assistant", content: tool ? null : "Hello from the fixture.", ...(tool ? { tool_calls: [{ id: "weather", type: "function", function: { name: "get_weather", arguments: '{"city":"Singapore"}' } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
    }
    if (!body.messages.some((message) => message.role === "tool")) return new Response([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "weather", type: "function", function: { name: "get_weather", arguments: '{"city":"Singapore"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    ].map((event) => `data: ${JSON.stringify({ id: "chat-fixture", model: "test", created: 1, ...event })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    return new Response('data: {"id":"chat-fixture","model":"test","created":1,"choices":[{"delta":{"content":"Hello from the fixture."},"index":0}]}\n\ndata: {"id":"chat-fixture","model":"test","created":1,"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
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
        cwd, env, openClient: openCliClient, fetch: globalThis.fetch,
        installProject: bundleEntry, mintId: () => crypto.randomUUID()
      }))), Effect.runPromise
    ).catch(error => { throw new Error(`${lines.join("\n")}\n${String(error)}`) })
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
    if (source === "interactive") {
      const key = (name: string, text?: string): Terminal.UserInput => ({ input: Option.fromUndefinedOr(text), key: { name, ctrl: false, meta: false, shift: false } })
      const typing = (text: string) => [...text].map((letter) => key(letter, letter))
      const enter = key("return")
      const inputs = [
        { ...key("u"), key: { ...key("u").key, ctrl: true } }, ...typing("tardie-agent"), enter,
        key("up"), enter,
        ...typing("fixture"), enter,
        key("down"), enter,
        ...typing(`${model.url}v1`), enter,
        ...typing("FIXTURE_KEY"), enter,
        ...typing("fixture-secret"), enter,
        ...typing("test"), enter,
        ...typing("0"), enter, key("backspace"), ...typing("32000"), enter,
        ...typing("4096"), enter,
        key("y", "y")
      ]
      let transcript = ""
      const queue = await Effect.runPromise(Queue.make<Terminal.UserInput, Cause.Done>())
      await Effect.runPromise(Queue.offerAll(queue, inputs))
      const terminal = Terminal.make({
        columns: Effect.succeed(100), rows: Effect.succeed(40), readInput: Effect.succeed(queue),
        readLine: Effect.die("prompts must consume key events"),
        display: (text) => Effect.sync(() => { transcript += text })
      })
      const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true })
      try {
        await Command.runWith(tdg, { version: "test", renderErrors: false })(["init"]).pipe(
          Effect.provideService(Terminal.Terminal, terminal),
          Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Cli, {
            cwd, env, openClient: openCliClient, fetch: globalThis.fetch,
            installProject: bundleEntry, mintId: () => crypto.randomUUID()
          }))), Effect.runPromise
        )
      } finally {
        if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY")
        else Object.defineProperty(process.stdin, "isTTY", descriptor)
      }
      for (const prompt of ["Actor name", "Which model provider?", "Provider name", "Which protocol", "Base URL", "Credential environment variable", "Default model ID", "Context window", "Maximum output", "support tool calls"]) {
        expect(transcript).toContain(prompt)
      }
      expect(transcript).not.toContain("fixture-secret")
      expect(transcript).toContain("Enter a positive safe integer")
    } else {
      await run("init", "tardie-agent", "--provider", "fixture", "--provider-config", JSON.stringify({ protocol: "openai-chat-completions", baseUrl: `${model.url}v1`, env: ["FIXTURE_KEY"], ...(source === "custom" ? { models: { test: { metadata: { contextWindowTokens: 32000, maxOutputTokens: 4096, toolCall: true } } } } : {}) }), "--default-model", "test", "--json")
    }
    cwd = join(root, "tardie-agent")
    const actorPath = join(cwd, "actor.ts")
    const actorSource = await readFile(actorPath, "utf8")
    await writeFile(actorPath, actorSource
      .replace('import { atom, defineActor } from "tardie/core"', 'import { actorMethod, atom, defineActor, event } from "tardie/core"')
      .replace('const actorName =', 'const Echoed = event({ type: "Echoed", text: Schema.String })\n\nconst actorName =')
      .replace('methods: agentMethods', `methods: { ...agentMethods, echo: actorMethod({
        inputSchema: Schema.String, outputSchema: Schema.String,
        onReceive: Echoed.from(text => ({ text })),
        result: input => ({ status: "completed", output: input }),
      }) }`), "utf8")
    await bundleEntry(cwd)
    expect(await readFile(join(cwd, "worker.ts"), "utf8")).toContain("createActorWorker")
    await run("lint", "actor.ts", "--json")
    expect(JSON.parse(await run("build", join(cwd, "actor.ts"), "--out", join(cwd, "artifact"), "--json"))).toMatchObject({ manifest: { name: "tardie-agent" } })
    const catalogCallsAfterInit = catalogCalls
    await start()
    const cliProcess = Bun.spawn([process.execPath, join(repository, "apps/cli/src/main.ts"), "methods", "--url", url, "--token", "fixture-token", "--json"], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const [cliOutput, cliError, cliCode] = await Promise.all([new Response(cliProcess.stdout).text(), new Response(cliProcess.stderr).text(), cliProcess.exited])
    expect(cliError).toBe("")
    expect(cliCode).toBe(0)
    expect(JSON.parse(cliOutput)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "message" }), expect.objectContaining({ name: "echo" })]))
    expect(JSON.parse(await remote("methods"))).toEqual(expect.arrayContaining([expect.objectContaining({ name: "message", cancellable: true })]))
    expect(JSON.parse(await remote("thread", "create", "--name", "main"))).toMatchObject({ thread: "main" })
    expect(JSON.parse(await remote("call", "echo", '"actor-owned"', "--thread", "main", "--id", "echo"))).toMatchObject({ status: "completed", output: "actor-owned" })
    expect(modelCalls).toBe(0)
    const completed = JSON.parse(await remote("call", "message", '{"text":"Hello"}', "--thread", "main", "--id", "hello", "--poll", "10"))
    expect(completed).toMatchObject({ status: "completed", output: { text: "Hello from the fixture." } })
    expect(modelCalls).toBe(2)
    const calls = modelCalls
    expect(JSON.parse(await remote("call", "message", '{"text":"Hello"}', "--thread", "main", "--id", "hello"))).toMatchObject({ status: "completed", output: completed.output })
    expect(modelCalls).toBe(calls)
    expect(JSON.parse(await remote("call", "state", "message", "hello", "--thread", "main"))).toMatchObject({ status: "completed" })
    expect(JSON.parse(await remote("events", "main"))).not.toHaveLength(0)
    const headers = { authorization: "Bearer fixture-token", "content-type": "application/json" }
    const childResponse = await fetch(`${url}/v1/actors/main/threads`, { method: "POST", headers, body: JSON.stringify({ name: "research", parent: "main" }) })
    expect(childResponse.ok).toBe(true)
    expect(await childResponse.json()).toMatchObject({ actor: "tardie-agent", instance: "main", thread: "research" })
    expect((await fetch(`${url}/v1/methods`)).status).toBe(401)
    const methodUrl = `${url}/v1/actors/main/threads/main/methods/message`
    expect((await fetch(methodUrl, { method: "POST", headers, body: '{"text":"No id"}' })).status).toBe(400)
    expect((await fetch(methodUrl, { method: "POST", headers: { ...headers, "idempotency-key": "invalid" }, body: '{}' })).status).toBe(400)
    expect((await fetch(methodUrl, { method: "POST", headers: { ...headers, "idempotency-key": "hello" }, body: '{"text":"Conflicting input"}' })).status).toBe(409)

    await expect(remote("call", "message", '{"text":"changed"}', "--thread", "main", "--id", "hello")).rejects.toThrow()
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
    expect(JSON.parse(await remote("call", "message", '{"text":"Hello"}', "--thread", "main", "--id", "hello"))).toMatchObject({ status: "completed", output: completed.output })
    expect(modelCalls).toBe(calls + 1)
    expect(catalogCalls).toBe(catalogCallsAfterInit)
    await stop()
    expect(JSON.parse(await run("models", "lock", "--json"))).toMatchObject({ schema: 2 })
    if (source === "registry") {
      const servicesPath = join(cwd, "services.ts")
      const servicesSource = `${await readFile(servicesPath, "utf8")}\nexport const applicationValue = 42\n`
      await writeFile(servicesPath, servicesSource)
      await run("setup", "provider", "anthropic", JSON.stringify({ protocol: "anthropic-messages", baseUrl: `${model.url}v1`, env: ["FIXTURE_KEY"], models: {
        "claude-fixture": { metadata: { contextWindowTokens: 32000, maxOutputTokens: 4096, toolCall: true } },
      } }))
      await run("setup", "default", "--provider", "anthropic", "--model", "claude-fixture")
      expect(await readFile(servicesPath, "utf8")).toBe(servicesSource)
      const registryPath = join(cwd, "generated/providers.ts")
      const registry = await readFile(registryPath, "utf8")
      expect(registry).toContain('from "tardie/model/providers/anthropic"')
      expect(registry).toContain('from "tardie/model/providers/openai-compat"')
      await expect(run("setup", "default", "--provider", "anthropic", "--model", "absent")).rejects.toThrow()
      expect(await readFile(registryPath, "utf8")).toBe(registry)
      await bundleEntry(cwd)
      await bundleEntry(cwd, "worker.ts")
      await start()
      const beforeSwitch = modelCalls
      expect(JSON.parse(await remote("call", "message", '{"text":"Hello"}', "--id", "anthropic", "--poll", "10"))).toMatchObject({ status: "completed", output: { text: "Hello from Anthropic." } })
      expect(modelCalls).toBe(beforeSwitch + 1)
      await stop()
    }
  } finally {
    child?.kill("SIGKILL")
    if (child) await child.exited
    await model.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

test("the generated server resolver supports the public model entry", async () => {
  const directory = await mkdtemp("/tmp/tardie-model-entry-")
  try {
    await writeFile(join(directory, "server.ts"), 'import { modelLayer } from "tardie/model"; export { modelLayer }\n')
    await bundleEntry(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
