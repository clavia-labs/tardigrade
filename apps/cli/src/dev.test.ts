import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Console, Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { ACTOR_ARTIFACT_VERSION, Infer, type Actor } from "tardie"
import type { Action } from "tardie/log/events"
import { PROBLEM_CONTENT_TYPE } from "@clavia/tardigrade-client/contract"
import { layerModelCatalogUnavailable } from "@clavia/tardigrade-server/catalog"

import { tdg } from "./commands"
import { resolveServer } from "./config"
import { availableDevPort, browserCommand, dev, DEV_HOST, DEV_URL_HOST, type DevOptions } from "./dev"
import { layerCli } from "./services"

// Every case here boots a real server on an ephemeral port, so it competes with every other task in
// a parallel gate run. Bun's default per-test budget is tuned for a pure function and times out
// under that load; this is the budget a boot actually needs. It stays tight on purpose: a case that
// wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

// One process end to end: the API the server declares and the UI the voyager builds, on one port,
// driven by the command a person types. The model seam is bound to a scripted mind, which is the
// same seam the server's own tests use (apps/server/src/api.test.ts), so this runs with no model
// credentials and reaches a completed turn anyway.

const INDEX = "<!doctype html><title>voyager</title>"

const SCRIPT = "console.log(\"voyager\")"
const testModel = { provider: "test", model_id: "scripted" } as const

// A directory shaped like the build vite writes: one index and one hashed asset beside it.
const buildDirectory = (): string => {
  const root = mkdtempSync(join(tmpdir(), "tardigrade-dev-"))
  writeFileSync(join(root, "index.html"), INDEX)
  mkdirSync(join(root, "assets"))
  writeFileSync(join(root, "assets", "app-abc123.js"), SCRIPT)
  return root
}

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  resolve: (model = testModel) => ({ model, models: { default: model, allow: "*" } }),
  react: () => Effect.succeed({ kind: "complete", output: "the scripted answer" } satisfies Action)
})

const directActor: Actor<never> = {
  name: "reviewer",
  methods: {},
  components: [],
  projections: [],
  keyOf: () => undefined
}

// booted starts the whole command on an ephemeral port and hands the body its base URL. ":memory:"
// keeps the store to this process, so the case owns every event it reads.
const booted = <A>(
  body: (baseUrl: string, hostname: string, actors: string) => Promise<A>,
  env: Record<string, string | undefined> = {},
  options: Pick<DevOptions, "actor" | "onListen" | "shutdownMillis"> = {}
): Promise<A> => {
  const actors = mkdtempSync(join(tmpdir(), "tardigrade-dev-actors-"))
  const actorData = mkdtempSync(join(tmpdir(), "tardigrade-dev-data-"))
  const running = Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    const port = address._tag === "TcpAddress" ? address.port : 0
    const hostname = address._tag === "TcpAddress" ? address.hostname : ""
    return yield* Effect.promise(() => body(`http://${hostname}:${port}`, hostname, actors))
  }).pipe(
    Effect.provide(
      dev({
        config: resolveServer({
          port: 0,
          db: ":memory:",
          actors,
          actorData
        }, env),
        assets: buildDirectory(),
        threads: { infer: layerScripted },
        catalog: layerModelCatalogUnavailable,
        disableLogger: true,
        disableListenLog: true,
        ...options
      })
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>
  return running.finally(() => {
    rmSync(actors, { recursive: true, force: true })
    rmSync(actorData, { recursive: true, force: true })
  })
}

// installActor performs the final atomic directory swap of a local push.
const installActor = (root: string, name: string, revision: string): string => {
  const module = `export default { name: ${JSON.stringify(name)}, revision: ${JSON.stringify(revision)}, methods: {}, components: [], projections: [], keyOf: () => undefined }\n`
  const digest = `sha256:${createHash("sha256").update(module).digest("hex")}`
  const destination = join(root, name)
  const incoming = `${destination}.incoming`
  const previous = `${destination}.previous`
  rmSync(incoming, { recursive: true, force: true })
  rmSync(previous, { recursive: true, force: true })
  mkdirSync(incoming, { recursive: true })
  writeFileSync(join(incoming, "actor.mjs"), module)
  writeFileSync(join(incoming, "manifest.json"), JSON.stringify({
    schema: ACTOR_ARTIFACT_VERSION,
    name,
    module: "actor.mjs",
    digest
  }))
  try {
    renameSync(destination, previous)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  renameSync(incoming, destination)
  rmSync(previous, { recursive: true, force: true })
  return digest
}

// Runs one invocation against the booted server through the real client, capturing what it printed.
const drive = async (baseUrl: string, args: ReadonlyArray<string>) => {
  const lines: Array<string> = []
  const capture: Console.Console = Object.assign(Object.create(console), {
    log: (...parts: ReadonlyArray<unknown>) => {
      lines.push(parts.map((part) => String(part)).join(" "))
    },
    error: () => {}
  })
  const exit = await Command.runWith(tdg, { version: "test", renderErrors: false })([...args, "--url", baseUrl]).pipe(
    Effect.provideService(Console.Console, capture),
    Effect.provide(Layer.mergeAll(BunServices.layer, layerCli)),
    Effect.runPromiseExit
  )
  return { lines, failed: Exit.isFailure(exit) }
}

describe("tdg dev", () => {
  test("the browser launcher is selected by the operating system", () => {
    expect(browserCommand("http://localhost:4242", "darwin")).toEqual(["open", "http://localhost:4242"])
    expect(browserCommand("http://localhost:4242", "linux")).toEqual(["xdg-open", "http://localhost:4242"])
    expect(browserCommand("http://localhost:4242", "win32")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "http://localhost:4242"
    ])
  })

  test("an occupied implicit port selects the next lower port", async () => {
    const tried: Array<number> = []
    const selected = await availableDevPort(4242, 4240, async (port, host) => {
      tried.push(port)
      expect(host).toBe(DEV_HOST)
      return port === 4240
    })
    expect(selected).toBe(4240)
    expect(tried).toEqual([4242, 4241, 4240])
  })

  test("an invalid fallback range is refused", async () => {
    expect(availableDevPort(4242, 4243)).rejects.toThrow("--min-port")
  })

  test("an open event stream does not delay shutdown", async () => {
    const started = Date.now()
    await booted(
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/actors/main/threads/stream`)
        await response.body!.getReader().read()
      },
      {},
      { shutdownMillis: 25 }
    ).catch((error) => {
      if (!(error instanceof Error) || error.message !== "All fibers interrupted without error") throw error
    })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("the browser callback receives a live UI URL after listening", async () => {
    let opened = ""
    const baseUrl = await booted(async (url) => url, {}, {
      onListen: async (url) => {
        opened = url
        expect((await fetch(`${url}/healthz`)).status).toBe(200)
      }
    })
    expect(new URL(opened).hostname).toBe(DEV_URL_HOST)
    expect(new URL(opened).port).toBe(new URL(baseUrl).port)
  })

  test("the API answers and the UI is served from one port", async () => {
    const seen = await booted(async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`)
      const index = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } })
      const asset = await fetch(`${baseUrl}/assets/app-abc123.js`)
      // A path the router does not own, asked for by something that renders HTML, is the UI's own
      // route: a deep link into the explorer is not a 404.
      const deep = await fetch(`${baseUrl}/v1/threads/root`, { headers: { accept: "text/html" } })
      // The same path asked for as JSON is still the API's answer, so a script sees the problem
      // document rather than a page.
      const ghost = await fetch(`${baseUrl}/v1/threads/ghost/events`, { headers: { accept: "application/json" } })
      return {
        health: { status: health.status, body: await health.json() },
        index: { status: index.status, body: await index.text(), type: index.headers.get("content-type") },
        asset: { status: asset.status, body: await asset.text(), type: asset.headers.get("content-type") },
        deep: { status: deep.status, body: await deep.text() },
        ghost: { status: ghost.status, type: ghost.headers.get("content-type") }
      }
    })
    expect(seen.health).toEqual({ status: 200, body: { status: "resting", dirty: 0 } })
    expect(seen.index.status).toBe(200)
    expect(seen.index.body).toBe(INDEX)
    expect(seen.index.type).toContain("text/html")
    expect(seen.asset.status).toBe(200)
    expect(seen.asset.body).toBe(SCRIPT)
    expect(seen.asset.type).toContain("javascript")
    expect(seen.deep.body).toBe(INDEX)
    expect(seen.ghost.status).toBe(404)
    expect(seen.ghost.type).toContain(PROBLEM_CONTENT_TYPE)
  })

  test("a project actor mounts directly", async () => {
    const response = await booted(async (baseUrl) => {
      const methods = await fetch(`${baseUrl}/v1/methods`)
      const metadata = await fetch(`${baseUrl}/v1/metadata`)
      return {
        current: { status: methods.status, body: await methods.json() },
        metadata: { status: metadata.status, body: await metadata.json() }
      }
    }, {}, { actor: directActor })

    expect(response).toEqual({
      current: { status: 200, body: [] },
      metadata: { status: 200, body: { name: "reviewer", storage: { kind: "sqlite", location: ":memory:" } } }
    })
  })

  test("a local push refreshes the actor registry", async () => {
    const seen = await booted(async (baseUrl, _hostname, actors) => {
      const waitFor = async (digest: string) => {
        let listed: ReadonlyArray<{ readonly name: string; readonly builtIn: boolean; readonly digest?: string }> = []
        for (let attempt = 0; attempt < 100; attempt++) {
          listed = await (await fetch(`${baseUrl}/v1/definitions`)).json() as typeof listed
          if (listed.some((actor) => actor.name === "reviewer" && actor.digest === digest)) return listed
          await Bun.sleep(10)
        }
        return listed
      }
      const first = installActor(actors, "reviewer", "first")
      await waitFor(first)
      const digest = installActor(actors, "reviewer", "second")
      const listed = await waitFor(digest)
      return { digest, listed }
    })
    expect(seen.listed).toContainEqual({ name: "reviewer", builtIn: false, digest: seen.digest })
  })

  // `tdg dev` is the local command: it binds loopback and carries no gate, so `TARDIGRADE_TOKEN` in
  // the environment changes nothing about it. A browser puts no bearer header on a top-level
  // navigation, and a server meant to be reachable by anyone else is the server run directly with
  // the token set (docs/how-to/server.md).
  test("the API answers without a token, on loopback", async () => {
    const seen = await booted(async (baseUrl, hostname) => {
      const listed = await fetch(`${baseUrl}/v1/actors`)
      const index = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } })
      return {
        hostname,
        listed: { status: listed.status, body: await listed.json() },
        index: index.status
      }
    }, { TARDIGRADE_TOKEN: "secret" })
    expect(seen.hostname).toBe(DEV_HOST)
    expect(seen.listed).toEqual({ status: 200, body: [] })
    expect(seen.index).toBe(200)
  })

  test("call drives a message to completed with no model credentials", async () => {
    const seen = await booted(async (baseUrl) => {
      const ran = await drive(baseUrl, ["call", "message", "{\"text\":\"survey the log\"}", "--thread", "root", "--id", "m1", "--poll", "10"])
      const listed = await drive(baseUrl, ["ls", "--json"])
      const logged = await drive(baseUrl, ["events", "root", "--types", "MessageReceived"])
      const ghost = await drive(baseUrl, ["events", "ghost"])
      return { baseUrl, ran, listed, logged, ghost }
    })
    expect(seen.ran.failed).toBe(false)
    expect(seen.ran.lines[0]).toBe(
      `root m1 completed\nthe scripted answer\n\ntrace\n  ${seen.baseUrl}/?thread=root`
    )
    expect(JSON.parse(seen.listed.lines[0] ?? "")).toMatchObject([{ id: "root", status: "settled" }])
    expect(seen.logged.lines[0]).toContain("MessageReceived")
    expect(seen.logged.lines[0]).toContain("survey the log")
    expect(seen.ghost.failed).toBe(true)
  })
})
