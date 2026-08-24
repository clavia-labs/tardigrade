import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { buildActor } from "./build"
import { DEFAULT_ACTOR_ENTRY, DEFAULT_WORKER_ENTRY, defaultInitDirectory, initActor, initSummary } from "./init"

let root = ""
const model = { provider: "openrouter", defaultModel: "anthropic/claude-sonnet-4-6" }

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const temporaryRoot = async (): Promise<string> => {
  root = await mkdtemp(join(process.cwd(), ".tdg-init-test-"))
  return root
}

describe("initActor", () => {
  test("creates a buildable named quickstart", async () => {
    const cwd = await temporaryRoot()
    const initialized = await initActor("reviewer", { cwd, model, now: new Date("2026-08-24T00:00:00Z") })
    const source = await readFile(initialized.entry, "utf8")
    const worker = await readFile(initialized.worker, "utf8")
    const manifest = JSON.parse(await readFile(initialized.manifest, "utf8")) as Record<string, unknown>
    const built = await buildActor(initialized.entry, { cwd: initialized.directory, out: "output" })

    expect(defaultInitDirectory("reviewer")).toBe("reviewer")
    expect(initialized.entry).toBe(join(cwd, "reviewer", DEFAULT_ACTOR_ENTRY))
    expect(initialized.worker).toBe(join(cwd, "reviewer", DEFAULT_WORKER_ENTRY))
    expect(source).toContain('const actorName = "reviewer"')
    expect(source).toContain('provider: "openrouter", default_model: "anthropic/claude-sonnet-4-6"')
    expect(worker).toContain('import definition from "./actor"')
    expect(worker).toContain('from "tardie/cloudflare"')
    expect(worker).toContain("cloudflareWorker(definition)")
    expect(manifest).toMatchObject({
      name: "reviewer",
      main: "worker.ts",
      compatibility_date: "2026-08-24",
      durable_objects: { bindings: [{ name: "ACTORS", class_name: "ActorHost" }] },
      worker_loaders: [{ binding: "LOADER" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["ActorHost"] }]
    })
    expect(manifest).not.toHaveProperty("d1_databases")
    expect(built.manifest.name).toBe("reviewer")
  })

  test("refuses to overwrite unless force is stated", async () => {
    const cwd = await temporaryRoot()
    const entry = join(cwd, "reviewer", DEFAULT_ACTOR_ENTRY)
    await initActor("reviewer", { cwd, model })
    await writeFile(entry, "keep me", "utf8")

    await expect(initActor("reviewer", { cwd, model })).rejects.toThrow("pass --force")
    expect(await readFile(entry, "utf8")).toBe("keep me")

    await initActor("reviewer", { cwd, model, force: true })
    expect(await readFile(entry, "utf8")).toContain('const actorName = "reviewer"')
  })

  test("writes into a stated directory", async () => {
    const cwd = await temporaryRoot()
    const initialized = await initActor("reviewer", { cwd, directory: "actors/custom", model })

    expect(initialized.entry).toBe(join(cwd, "actors", "custom", DEFAULT_ACTOR_ENTRY))
  })
})

describe("initSummary", () => {
  test("prints the complete local path", async () => {
    const cwd = await temporaryRoot()
    const initialized = await initActor("reviewer", { cwd, model })
    const summary = initSummary(initialized, cwd)

    expect(summary).toContain("created reviewer/actor.ts")
    expect(summary).toContain("created reviewer/worker.ts")
    expect(summary).toContain("created reviewer/wrangler.jsonc")
    expect(summary).toContain("cd reviewer")
    expect(summary).not.toContain("tdg push")
    expect(summary).not.toContain("tdg build actor.ts")
    expect(summary).toContain("tdg call message")
    expect(summary).toContain("tdg dev")
    expect(summary).toContain("bunx wrangler deploy")
    expect(summary).toContain('--actor reviewer')
  })
})
