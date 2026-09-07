import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { analyzeGraph } from "./code-graph/analyze"
import { renderGraph } from "./code-graph/render"

const root = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
const check = args.includes("--check")
const outIndex = args.indexOf("--out")
if (outIndex >= 0 && (!args[outIndex + 1] || args[outIndex + 1]!.startsWith("--"))) throw new Error("--out needs a directory")
const out = resolve(root, outIndex < 0 ? "artifacts/code-graph" : args[outIndex + 1]!)
const graph = await analyzeGraph(root)
console.log(`${graph.nodes.length} files, ${graph.edges.length} internal import sites, ${graph.packages.length} packages`)
console.log(`${graph.violations.length} boundary violations, ${graph.cycles.length} production runtime cycle groups, ${graph.unresolved.length} unresolved/computed import sites`)
for (const violation of graph.violations) console.log(`${violation.source}:${violation.line} [${violation.rule}] ${violation.message}`)
if (!check) {
  await mkdir(out, { recursive: true })
  const ids = new Map(graph.packages.map((pkg, index) => [pkg.id, `p${index}`]))
  const owners = new Map(graph.nodes.map((node) => [node.id, node]))
  const links = new Set<string>()
  for (const edge of graph.edges) {
    const from = owners.get(edge.source), to = owners.get(edge.target)
    if (!from || !to || from.test || to.test || edge.typeOnly || from.package === to.package) continue
    if (ids.has(from.package) && ids.has(to.package)) links.add(`  ${ids.get(from.package)} --> ${ids.get(to.package)}`)
  }
  const mermaid = ["flowchart LR", ...graph.packages.map((pkg) => `  ${ids.get(pkg.id)}[${JSON.stringify(pkg.id)}]`), ...[...links].sort()].join("\n")
  await Promise.all([
    writeFile(resolve(out, "index.html"), renderGraph(graph)),
    writeFile(resolve(out, "graph.json"), JSON.stringify(graph)),
    writeFile(resolve(out, "packages.mmd"), mermaid + "\n")
  ])
  console.log(`Open ${resolve(out, "index.html")}`)
}
for (const cycle of graph.cycles) console.log(`Runtime cycle: ${cycle.join(", ")}`)
if (check && (graph.violations.length || graph.cycles.length)) process.exitCode = 1
