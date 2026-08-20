import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Console, Effect, Exit, Layer } from "effect"
import { HttpServer } from "effect/unstable/http"
import { Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { Infer } from "tardie"
import type { Action } from "tardie/events"
import { PROBLEM_CONTENT_TYPE } from "@clavia/tardigrade-client/contract"

import { tdg } from "./commands"
import { resolveServer } from "./config"
import { dev, DEV_HOST } from "./dev"
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

// A directory shaped like the build vite writes: one index and one hashed asset beside it.
const buildDirectory = (): string => {
  const root = mkdtempSync(join(tmpdir(), "tardigrade-dev-"))
  writeFileSync(join(root, "index.html"), INDEX)
  mkdirSync(join(root, "assets"))
  writeFileSync(join(root, "assets", "app-abc123.js"), SCRIPT)
  return root
}

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: () => Effect.succeed({ kind: "complete", output: "the scripted answer" } satisfies Action)
})

// booted starts the whole command on an ephemeral port and hands the body its base URL. ":memory:"
// keeps the store to this process, so the case owns every event it reads.
const booted = <A>(
  body: (baseUrl: string, hostname: string) => Promise<A>,
  env: Record<string, string | undefined> = {}
): Promise<A> =>
  Effect.gen(function*() {
    const server = yield* HttpServer.HttpServer
    const address = server.address
    const port = address._tag === "TcpAddress" ? address.port : 0
    const hostname = address._tag === "TcpAddress" ? address.hostname : ""
    return yield* Effect.promise(() => body(`http://${hostname}:${port}`, hostname))
  }).pipe(
    Effect.provide(
      dev({
        config: resolveServer({ port: 0, db: ":memory:" }, env),
        assets: buildDirectory(),
        threads: { infer: layerScripted },
        disableLogger: true,
        disableListenLog: true
      })
    ),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

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
  test("the API answers and the UI is served from one port", async () => {
    const seen = await booted(async (baseUrl) => {
      const health = await fetch(`${baseUrl}/healthz`)
      const index = await fetch(`${baseUrl}/`, { headers: { accept: "text/html" } })
      const asset = await fetch(`${baseUrl}/assets/app-abc123.js`)
      // A path the router does not own, asked for by something that renders HTML, is the UI's own
      // route: a deep link into the explorer is not a 404.
      const deep = await fetch(`${baseUrl}/v1/actors/agent/threads/root`, { headers: { accept: "text/html" } })
      // The same path asked for as JSON is still the API's answer, so a script sees the problem
      // document rather than a page.
      const ghost = await fetch(`${baseUrl}/v1/actors/agent/threads/ghost/events`, { headers: { accept: "application/json" } })
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

  // `tdg dev` is the local command: it binds loopback and carries no gate, so `TARDIGRADE_TOKEN` in
  // the environment changes nothing about it. A browser puts no bearer header on a top-level
  // navigation, and a server meant to be reachable by anyone else is the server run directly with
  // the token set (docs/how-to/server.md).
  test("the API answers without a token, on loopback", async () => {
    const seen = await booted(async (baseUrl, hostname) => {
      const listed = await fetch(`${baseUrl}/v1/actors/agent/threads`)
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

  test("run drives a brief to a completed turn with no model credentials", async () => {
    const seen = await booted(async (baseUrl) => {
      const ran = await drive(baseUrl, ["run", "survey the log", "--thread", "root", "--id", "m1", "--poll", "10"])
      const listed = await drive(baseUrl, ["ls", "--json"])
      const logged = await drive(baseUrl, ["events", "root", "--types", "MessageReceived"])
      const ghost = await drive(baseUrl, ["events", "ghost"])
      return { ran, listed, logged, ghost }
    })
    expect(seen.ran.failed).toBe(false)
    expect(seen.ran.lines[0]).toBe("root m1 completed\nthe scripted answer")
    expect(JSON.parse(seen.listed.lines[0] ?? "")).toMatchObject([{ id: "root", status: "settled" }])
    expect(seen.logged.lines[0]).toContain("MessageReceived")
    expect(seen.logged.lines[0]).toContain("survey the log")
    expect(seen.ghost.failed).toBe(true)
  })
})
