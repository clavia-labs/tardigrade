import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { buildActor } from "./build"
import { actorTemplate, defaultActorInstructions } from "./template"

let root = ""

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const build = async (source: string) => {
  root = await mkdtemp(join(process.cwd(), ".tdg-template-test-"))
  const entry = join(root, "actor.ts")
  await writeFile(entry, source, "utf8")
  return buildActor(entry, { cwd: root, out: "output" })
}

describe("actorTemplate", () => {
  test("builds a named actor with the useful local reach", async () => {
    const source = actorTemplate({ name: "researcher" })
    const built = await build(source)

    expect(built.manifest.name).toBe("researcher")
    expect(source).toContain(defaultActorInstructions("researcher"))
    expect(source).toContain("filesPackage()")
    expect(source).toContain("fetchPackage()")
    expect(source).toContain("agentsPackage()")
    expect(source).toContain("workspacePackage()")
  })

  test("keeps custom instructions valid inside the editable template literal", async () => {
    const source = actorTemplate({
      name: "reviewer",
      instructions: "Review `src` and explain ${findings}.\nKeep Windows paths like C:\\code intact."
    })
    const built = await build(source)

    expect(built.manifest.name).toBe("reviewer")
    expect(source).toContain("Review \\`src\\` and explain \\${findings}.")
    expect(source).toContain("C:\\\\code")
  })

  test("refuses an invalid name or blank instructions", () => {
    expect(() => actorTemplate({ name: "Release Analyst" })).toThrow("actor name must match")
    expect(() => actorTemplate({ name: "reviewer", instructions: "   " })).toThrow(
      "actor instructions must not be blank"
    )
  })
})
