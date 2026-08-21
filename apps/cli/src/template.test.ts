import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { buildActor } from "./build"
import { actorTemplate, renderActorTemplate } from "./template"

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
    const source = await actorTemplate({ name: "reviewer" })
    const built = await build(source)

    expect(built.manifest.name).toBe("reviewer")
    expect(source).toContain('const actorName = "reviewer"')
    expect(source).toContain("You are ${actorName}, a focused research agent.")
    expect(source).toContain("filesPackage()")
    expect(source).toContain("fetchPackage()")
    expect(source).toContain("agentsPackage()")
    expect(source).toContain("workspacePackage()")
  })

  test("keeps custom instructions valid inside the editable template literal", async () => {
    const source = await actorTemplate({
      name: "reviewer",
      instructions: "Review `src` and explain ${findings}.\nKeep Windows paths like C:\\code intact."
    })
    const built = await build(source)

    expect(built.manifest.name).toBe("reviewer")
    expect(source).toContain("Review \\`src\\` and explain \\${findings}.")
    expect(source).toContain("C:\\\\code")
  })

  test("refuses an invalid name or blank instructions", async () => {
    await expect(actorTemplate({ name: "Release Analyst" })).rejects.toThrow("actor name must match")
    await expect(actorTemplate({ name: "reviewer", instructions: "   " })).rejects.toThrow(
      "actor instructions must not be blank"
    )
  })

  test("refuses a template without its editable fields", () => {
    expect(() => renderActorTemplate("export default {}", { name: "reviewer" })).toThrow(
      "quickstart template must contain one actorName declaration"
    )
  })
})
