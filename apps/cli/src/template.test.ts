import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildActor } from "./build"
import { actorTemplate, renderActorTemplate } from "./template"

let root = ""
const model = { provider: "openrouter", defaultModel: "anthropic/claude-sonnet-4-6" }

afterEach(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true })
})

const build = async (source: string) => {
  root = await mkdtemp(join(tmpdir(), "tardigrade-template-test-"))
  const entry = join(root, "actor.ts")
  await writeFile(entry, source, "utf8")
  return buildActor(entry, { cwd: root, out: "output" })
}

describe("actorTemplate", () => {
  test("builds a named actor with the useful local reach", async () => {
    const source = await actorTemplate({ name: "reviewer", model })
    const built = await build(source)

    expect(built.manifest.name).toBe("reviewer")
    expect(source).toContain('const actorName = "reviewer"')
    expect(source).toContain('provider: "openrouter", default_model: "anthropic/claude-sonnet-4-6"')
    expect(source).toContain("You are ${actorName}, a focused research agent.")
    expect(source).toContain("filesPackage()")
    expect(source).toContain("fetchPackage()")
    expect(source).toContain("agentsPackage()")
    expect(source).toContain("workspacePackage()")
  })

  test("keeps custom instructions valid inside the editable template literal", async () => {
    const source = await actorTemplate({
      name: "reviewer",
      model,
      instructions: "Review `src` and explain ${findings}.\nKeep Windows paths like C:\\code intact."
    })
    const built = await build(source)

    expect(built.manifest.name).toBe("reviewer")
    expect(source).toContain("Review \\`src\\` and explain \\${findings}.")
    expect(source).toContain("C:\\\\code")
  })

  test("refuses an invalid name or blank instructions", async () => {
    await expect(actorTemplate({ name: "Release Analyst", model })).rejects.toThrow("actor name must match")
    await expect(actorTemplate({ name: "reviewer", model, instructions: "   " })).rejects.toThrow(
      "actor instructions must not be blank"
    )
  })

  test("refuses a template without its editable fields", () => {
    expect(() => renderActorTemplate("export default {}", { name: "reviewer", model })).toThrow(
      "quickstart template must contain one actorName declaration"
    )
  })
})
