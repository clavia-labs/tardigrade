import { cp, mkdir, rm } from "node:fs/promises"
import { INIT_TEMPLATES } from "../apps/cli/src/template"
import { dirname, join, relative } from "node:path"

// rewriteComponentRuntimeImports preserves private relative imports when packages share a staged source root (publish-paths.test.ts).
export const rewriteComponentRuntimeImports = (source: string, file: string, sourceRoot: string): string => {
  const target = relative(dirname(file), join(sourceRoot, "deprecated/core/component/runtime"))
  return source.replace(/(["'])(?:\.\.\/)+(?:deprecated\/)?core\/src\/component\/runtime\1/g,
    (_match, quote: string) => `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`)
}

// stageInitTemplates copies scaffold sources into a clean template directory (publish-paths.test.ts).
export const stageInitTemplates = async (root: string, stage: string): Promise<void> => {
  const destination = join(stage, "examples")
  await rm(destination, { recursive: true, force: true })
  await Promise.all(INIT_TEMPLATES.map(async template => {
    const target = join(destination, template)
    await mkdir(target, { recursive: true })
    const files = template === "quickstart" ? ["actor.ts", "services.ts.template", "server.ts.template", "worker.ts.template"] : ["actor.ts"]
    for (const file of files) await cp(join(root, "examples", template, file), join(target, file))
  }))
}
