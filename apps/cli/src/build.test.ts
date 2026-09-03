import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ACTOR_ARTIFACT_VERSION } from "tardie"

import { ACTOR_MANIFEST_FILE, ACTOR_MODULE_FILE, buildActor, buildSummary, lintActor, lintSummary } from "./build"

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
      import { actor } from "tardie"
      export default actor({
        name: "researcher",
        methods: {},
        components: []
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
    const path = await entry("export default { actor: { projections: [], keyOf: () => 'root' } }")
    await expect(buildActor(path, { cwd: root, out: "output" })).rejects.toThrow("name must match")
  })

  test("refuses an actor with no callable interface", async () => {
    const path = await entry(`
      export default {
        name: "researcher",
        components: [], projections: [], keyOf: () => "root"
      }
    `)
    await expect(buildActor(path, { cwd: root, out: "output" })).rejects.toThrow("must declare its methods")
  })

  test("the summary identifies the artifact", async () => {
    const path = await entry(`
      import { actor } from "tardie"
      export default actor({
        name: "researcher",
        methods: {},
        components: []
      })
    `)
    const built = await buildActor(path, { cwd: root, out: "output" })

    expect(buildSummary(built)).toBe([
      "built researcher",
      `at    ${built.directory}`,
      `hash  ${built.manifest.digest}`
    ].join("\n"))
  })
})

describe("lintActor", () => {
  test("reports the methods and calls derived from component contracts", async () => {
    const path = await entry(`
      import {
        actor, agentMethods, budget, budgetAuthority, caller, codeMode, infer, nativeOutput
      } from "tardie"
      export default actor({
        name: "researcher",
        methods: agentMethods,
        components: [
          infer([budget([codeMode()], { authority: caller() }), nativeOutput], {
            models: {
              default: { provider: "test", model_id: "test" },
              allow: "*"
            }
          }),
          budgetAuthority()
        ]
      })
    `)
    const linted = await lintActor(path, { cwd: root })
    expect(linted).toEqual({
      name: "researcher",
      methods: [
        { name: "message", handling: ["local"] },
        { name: "requestBudget", handling: ["local"] }
      ],
      calls: [{ method: "requestBudget", target: "caller" }]
    })
    expect(lintSummary(linted)).toBe("linted  researcher\nmethods 2\ncalls   1")
  })

  test("refuses a declared method with no component handler", async () => {
    const path = await entry(`
      import { actor, agentMessageMethod } from "tardie"
      export default actor({ name: "researcher", methods: { message: agentMessageMethod }, components: [] })
    `)
    await expect(lintActor(path, { cwd: root })).rejects.toThrow('method "message" has no handler')
  })
})
