import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { rewriteComponentRuntimeImports, stageInitTemplates } from "./publish-paths"

test("private runtime imports resolve inside the assembled package", () => {
  expect(rewriteComponentRuntimeImports('import { machineOf } from "../../../../core/src/component/runtime"',
    "/stage/src/agent/component/budget/index.ts", "/stage/src"))
    .toBe('import { machineOf } from "../../../core/component/runtime"')
  expect(rewriteComponentRuntimeImports("import { registerComponent } from '../../../core/src/component/runtime'",
    "/stage/src/code/package/definition.ts", "/stage/src"))
    .toBe("import { registerComponent } from '../../core/component/runtime'")
  const withinCore = 'import { machineOf } from "./runtime"'
  expect(rewriteComponentRuntimeImports(withinCore, "/stage/src/core/component/machine.ts", "/stage/src")).toBe(withinCore)
})

test("template staging excludes local state and secrets, including stale output", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-templates-"))
  const stage = join(root, "stage")
  try {
    for (const template of ["quickstart", "rlm"]) {
      const source = join(root, "examples", template)
      await mkdir(join(source, ".tardigrade"), { recursive: true })
      await writeFile(join(source, "actor.ts"), `export default "${template}"`)
      await writeFile(join(source, ".env"), "SECRET=fixture")
      await writeFile(join(source, ".tardigrade", "actor.sqlite"), "private conversation")
    }
    await mkdir(join(stage, "examples", "old-template"), { recursive: true })
    await writeFile(join(stage, "examples", "old-template", ".dev.vars"), "SECRET=stale")
    await stageInitTemplates(root, stage)
    expect((await readdir(join(stage, "examples"))).sort()).toEqual(["quickstart", "rlm"])
    for (const template of ["quickstart", "rlm"]) {
      const target = join(stage, "examples", template)
      expect(await readdir(target)).toEqual(["actor.ts"])
      expect(await readFile(join(target, "actor.ts"), "utf8")).toBe(`export default "${template}"`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
