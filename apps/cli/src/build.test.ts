import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ACTOR_ARTIFACT_VERSION } from "tardie"

import { ACTOR_MANIFEST_FILE, ACTOR_MODULE_FILE, buildActor } from "./build"

let root = ""

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const entry = async (source: string): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), "tdg-build-test-"))
  const path = join(root, "actor.ts")
  await writeFile(path, source, "utf8")
  return path
}

describe("buildActor", () => {
  test("writes a named portable artifact", async () => {
    const path = await entry(`
      import { defineActor } from "tardie"
      export default defineActor({
        name: "researcher",
        actor: { reactors: [], keyOf: () => "root" }
      })
    `)
    const built = await buildActor(path, { cwd: root, out: "output" })
    expect(built.directory).toBe(join(root, "output", "researcher"))
    expect(await readFile(join(built.directory, ACTOR_MODULE_FILE), "utf8")).toContain("researcher")
    expect(JSON.parse(await readFile(join(built.directory, ACTOR_MANIFEST_FILE), "utf8"))).toEqual(built.manifest)
    expect(built.manifest.schema).toBe(ACTOR_ARTIFACT_VERSION)
    expect(built.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("refuses an unnamed module", async () => {
    const path = await entry("export default { actor: { reactors: [], keyOf: () => 'root' } }")
    await expect(buildActor(path, { cwd: root, out: "output" })).rejects.toThrow("name must match")
  })
})
