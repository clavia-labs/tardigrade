import { dirname, join, relative } from "node:path"

// rewriteComponentRuntimeImports preserves private relative imports when packages share a staged source root (publish-paths.test.ts).
export const rewriteComponentRuntimeImports = (source: string, file: string, sourceRoot: string): string => {
  const target = relative(dirname(file), join(sourceRoot, "core/component/runtime"))
  return source.replace(/(["'])(?:\.\.\/)+core\/src\/component\/runtime\1/g,
    (_match, quote: string) => `${quote}${target.startsWith(".") ? target : `./${target}`}${quote}`)
}
