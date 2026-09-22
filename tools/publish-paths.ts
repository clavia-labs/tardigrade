import { cp, mkdir, rm } from "node:fs/promises"
import { INIT_TEMPLATES } from "../apps/cli/src/template"
import { dirname, join, relative } from "node:path"

// rewriteComponentRuntimeImports preserves private relative imports when packages share a staged source root (publish-paths.test.ts).
export const rewriteComponentRuntimeImports = (source: string, file: string, sourceRoot: string): string => {
  const target = relative(dirname(file), join(sourceRoot, "core/component/runtime"))
  return source.replace(/(["'])(?:\.\.\/)+core\/src\/component\/runtime\1/g,
    (_match, quote: string) => `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`)
}

// stageInitTemplates copies only actor sources into a clean template directory (publish-paths.test.ts).
export const stageInitTemplates = async (root: string, stage: string): Promise<void> => {
  const destination = join(stage, "examples")
  await rm(destination, { recursive: true, force: true })
  await Promise.all(INIT_TEMPLATES.map(async template => {
    const target = join(destination, template)
    await mkdir(target, { recursive: true })
    await cp(join(root, "examples", template, "actor.ts"), join(target, "actor.ts"))
  }))
}
