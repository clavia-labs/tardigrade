import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { buildActor } from "./build"
import { CELLD_PROJECT_CONFIG_PATH } from "./celld"
import { DEFAULT_ACTOR_ENTRY, DEFAULT_PACKAGE_MANIFEST, DEFAULT_WORKER_ENTRY, defaultInitDirectory, initActor, initSummary, terminalColorsEnabled } from "./init"

let root = ""
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
    const initialized = await initActor("reviewer", { cwd, now: new Date("2026-08-24T00:00:00Z"), packageVersion: "0.7.1-test" })
    const source = await readFile(initialized.entry, "utf8")
    const worker = await readFile(initialized.worker, "utf8")
    const manifestSource = await readFile(initialized.manifest, "utf8")
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>
    const celldManifest = JSON.parse(await readFile(initialized.celldManifest, "utf8")) as Record<string, unknown>
    const packageManifest = JSON.parse(await readFile(initialized.packageManifest, "utf8")) as Record<string, unknown>
    const built = await buildActor(initialized.entry, { cwd: initialized.directory, out: "output" })

    expect(defaultInitDirectory("reviewer")).toBe("reviewer")
    expect(initialized.entry).toBe(join(cwd, "reviewer", DEFAULT_ACTOR_ENTRY))
    expect(initialized.worker).toBe(join(cwd, "reviewer", DEFAULT_WORKER_ENTRY))
    expect(initialized.celldManifest).toBe(join(cwd, "reviewer", CELLD_PROJECT_CONFIG_PATH))
    expect(initialized.packageManifest).toBe(join(cwd, "reviewer", DEFAULT_PACKAGE_MANIFEST))
    expect(source).toContain('const actorName = "reviewer"')
    expect(source).toContain("infer([")
    expect(worker).toContain('import definition from "./actor"')
    expect(worker).toContain('from "tardie/cloudflare"')
    expect(worker).toContain('import { modelAdapters } from "tardie/model/adapter"')
    expect(worker).toContain('import { openAICompatibleAdapter } from "tardie/model/openai"')
    expect(worker).toContain("modelAdapters: modelAdapters(openAICompatibleAdapter)")
    expect(manifest).toMatchObject({
      name: "reviewer",
      main: "worker.ts",
      compatibility_date: "2026-08-24",
      durable_objects: { bindings: [
        { name: "ACTORS", class_name: "ActorDO" },
        { name: "THREADS", class_name: "ThreadDO" }
      ] },
      worker_loaders: [{ binding: "LOADER" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["ActorDO", "ThreadDO"] }]
    })
    expect(manifest).not.toHaveProperty("d1_databases")
    expect(Object.keys(celldManifest).sort()).toEqual([
      "$schema",
      "compatibility_date",
      "compatibility_flags",
      "durable_objects",
      "main",
      "migrations",
      "name",
      "vars"
    ])
    expect((celldManifest["vars"] as Record<string, string>)["TARDIGRADE_CONFIG"]).toBe("{}")
    expect((celldManifest["vars"] as Record<string, string>)["TARDIGRADE_SANDBOX_TRANSPORT"]).toBe("replay")
    expect((celldManifest["vars"] as Record<string, string>)["TARDIGRADE_BACKGROUND_TASK_OWNER"]).toBe("request")
    expect(packageManifest).toEqual({ private: true, type: "module", dependencies: { tardie: "0.7.1-test" } })
    expect(built.manifest.name).toBe("reviewer")
  })

  test("requires ownership of a new target", async () => {
    const cwd = await temporaryRoot()
    const directory = join(cwd, "reviewer")
    const held = join(directory, "wrangler.jsonc")
    await mkdir(directory)
    await writeFile(held, "keep me", "utf8")

    await expect(initActor("reviewer", { cwd })).rejects.toThrow("target already exists")
    expect(await readFile(held, "utf8")).toBe("keep me")
  })

  test("writes into a stated directory", async () => {
    const cwd = await temporaryRoot()
    const initialized = await initActor("reviewer", { cwd, directory: "actors/custom" })

    expect(initialized.entry).toBe(join(cwd, "actors", "custom", DEFAULT_ACTOR_ENTRY))
  })

})

describe("initSummary", () => {
  test("prints the complete local path", async () => {
    const cwd = await temporaryRoot()
    const initialized = await initActor("reviewer", { cwd })
    const summary = initSummary(initialized, {
      configPath: initialized.manifest,
      celldConfigPath: initialized.celldManifest,
      secretsPath: join(initialized.directory, ".dev.vars")
    }, {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      credential: "held",
      protocol: "openai-chat-completions",
      env: ["OPENROUTER_API_KEY"],
      model_id: "google/gemini-flash-latest"
    }, { cwd })

    expect(summary).toBe(`
  ✓ actor "reviewer" created in ./reviewer
    files       actor.ts
                worker.ts
                wrangler.jsonc
                celld.jsonc
                package.json
    credential  OPENROUTER_API_KEY (.dev.vars)

  → next
    cd reviewer
    tdg dev

  → call from another terminal
    tdg call message '{"text":"Read this repository and tell me what it does"}'

  ↗ deploy
    Cloudflare  bunx wrangler deploy
    Celld       celld deploy --config celld.jsonc

  ? help
    https://discord.gg/Z74jwRxz4k
`)
  })

  test("uses color only for an interactive terminal", () => {
    expect(terminalColorsEnabled({}, true)).toBe(true)
    expect(terminalColorsEnabled({ NO_COLOR: "1" }, true)).toBe(false)
    expect(terminalColorsEnabled({}, false)).toBe(false)
  })
})
