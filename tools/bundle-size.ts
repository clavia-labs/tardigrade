import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { join } from "node:path"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(root, "output/bundle-size")
const fixtures = ["atoms", "counter", "replay", "core"] as const
const results: { fixture: string; effect: string; minifiedBytes: number; gzipBytes: number; externalImports: string[] }[] = []
await mkdir(output, { recursive: true })
for (const fixture of fixtures) {
  for (const effect of ["external", "included"] as const) {
    const build = await Bun.build({
      entrypoints: [join(root, `tools/bundle-size/${fixture}.ts`)],
      target: "bun", format: "esm", minify: true, sourcemap: "none",
      external: effect === "external" ? ["effect", "effect/*"] : [],
    })
    if (!build.success) throw new AggregateError(build.logs, `Failed to bundle ${fixture}`)
    const artifact = build.outputs[0]
    if (!artifact || build.outputs.length !== 1) throw new Error("Expected one JavaScript bundle")
    const bytes = new Uint8Array(await artifact.arrayBuffer())
    const compressed = gzipSync(bytes, { level: 9 })
    const text = new TextDecoder().decode(bytes)
    const externalImports = [...new Set([...text.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(match => match[1]!))].sort()
    await writeFile(join(output, `${fixture}-${effect}.mjs`), bytes)
    await writeFile(join(output, `${fixture}-${effect}.mjs.gz`), compressed)
    results.push({ fixture, effect, minifiedBytes: bytes.length, gzipBytes: compressed.length, externalImports })
  }
}
const report = { bun: Bun.version, effect: (await Bun.file(join(root, "node_modules/effect/package.json")).json()).version as string, target: "bun", format: "esm", compression: "gzip level 9", source: "workspace, public tardie/core facade", results }
await writeFile(join(output, "results.json"), `${JSON.stringify(report, null, 2)}\n`)
console.table(results.map(({ fixture, effect, minifiedBytes, gzipBytes }) => ({ fixture, effect, "minified kB": (minifiedBytes / 1000).toFixed(2), "gzip kB": (gzipBytes / 1000).toFixed(2) })))
const { runCounter } = await import(join(output, "replay-included.mjs")) as { runCounter: () => Promise<number> }
if (await runCounter() !== 1) throw new Error("Bundled counter did not increment to 1")
console.log("Bundled counter replay: 1")
console.log(`Report: ${join(output, "results.json")}`)
