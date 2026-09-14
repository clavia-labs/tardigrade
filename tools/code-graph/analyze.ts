import { parseSync } from "oxc-parser"
import { existsSync, realpathSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import type { GraphData, GraphEdge, GraphNode, PackageNode, Violation } from "./types"

const groupBy = <T, K>(items: ReadonlyArray<T>, keyOf: (item: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [item])
    else group.push(item)
  }
  return groups
}

interface ImportSite {
  readonly specifier: string
  readonly line: number
  readonly kind: GraphEdge["kind"]
  readonly typeOnly: boolean
}

// importsOf extracts literal imports and reexports without matching comments or string contents.
export const importsOf = (file: string, source: string): ImportSite[] => {
  const parsed = parseSync(file, source)
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors.map((error) => error.message).join("; ")}`)
  const sites: ImportSite[] = []
  const line = (at: number) => source.slice(0, at).split("\n").length
  for (const entry of parsed.module.staticImports) sites.push({
    specifier: entry.moduleRequest.value, line: line(entry.start), kind: "import",
    typeOnly: entry.entries.length > 0 && entry.entries.every((binding) => binding.isType)
  })
  for (const entry of parsed.module.staticExports) {
    const groups = groupBy(entry.entries.filter((binding) => binding.moduleRequest !== null), (binding) => binding.moduleRequest!.value)
    for (const [specifier, bindings] of groups) sites.push({ specifier, line: line(entry.start), kind: "export", typeOnly: bindings.every((binding) => binding.isType) })
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (typeof value !== "object" || value === null) return
    const node = value as Record<string, unknown>
    const type = node["type"]
    const start = typeof node["start"] === "number" ? node["start"] : 0
    const literal = (value: unknown): string | undefined => {
      if (typeof value !== "object" || value === null) return undefined
      const candidate = value as Record<string, unknown>
      return typeof candidate["value"] === "string" ? candidate["value"] : undefined
    }
    if (type === "ImportExpression") {
      const specifier = literal(node["source"])
      sites.push({ specifier: specifier ?? "<computed dynamic import>", line: line(start), kind: "dynamic", typeOnly: false })
    }
    if (type === "TSImportType") {
      const specifier = literal(node["argument"]) ?? literal(node["source"])
      if (specifier) sites.push({ specifier, line: line(start), kind: "import", typeOnly: true })
    }
    if (type === "CallExpression") {
      const callee = node["callee"] as Record<string, unknown> | undefined
      if (callee?.["type"] === "Identifier" && callee["name"] === "require") {
        const args = node["arguments"] as unknown[]
        sites.push({ specifier: literal(args[0]) ?? "<computed require>", line: line(start), kind: "require", typeOnly: false })
      }
    }
    for (const [key, child] of Object.entries(node)) if (key !== "comments" && key !== "tokens") walk(child)
  }
  walk(parsed.program)
  return sites.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier))
}

// cycleGroups returns strongly connected groups in production value imports (analyze.test.ts).
export const cycleGroups = (nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string[][] => {
  const active = new Set(nodes.filter((node) => !node.test).map((node) => node.id))
  const adjacent = new Map<string, string[]>()
  for (const edge of edges) if (!edge.typeOnly && active.has(edge.source) && active.has(edge.target)) {
    adjacent.set(edge.source, [...(adjacent.get(edge.source) ?? []), edge.target])
  }
  let next = 0
  const indices = new Map<string, number>(), low = new Map<string, number>(), stacked = new Set<string>()
  const stack: string[] = [], groups: string[][] = []
  const visit = (id: string): void => {
    const index = next++
    indices.set(id, index); low.set(id, index); stack.push(id); stacked.add(id)
    for (const target of adjacent.get(id) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)) }
      else if (stacked.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!))
    }
    if (low.get(id) !== indices.get(id)) return
    const group: string[] = []
    let member: string
    do { member = stack.pop()!; stacked.delete(member); group.push(member) } while (member !== id)
    if (group.length > 1 || adjacent.get(id)?.includes(id)) groups.push(group.sort())
  }
  for (const id of [...active].sort()) if (!indices.has(id)) visit(id)
  return groups.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!))
}

export const boundaryViolations = (nodes: readonly GraphNode[], edges: readonly GraphEdge[], packages: readonly PackageNode[]): Violation[] => {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const violations: Violation[] = []
  const ruleOf = (from: { id: string; layer: string }, to: { id: string; layer: string }): string | undefined => {
    if (from.id === to.id) return undefined
    if (from.layer === "core" && to.layer !== "core") return "core-only"
    if (from.layer === "model" && to.layer !== "model") return "model-independent"
    if (from.layer === "host" && !["core", "host"].includes(to.layer)) return "host-inward"
    if (from.id.startsWith("packages/") && from.layer !== "facade" && ["platform", "app"].includes(to.layer)) return "shared-portable"
    if (from.layer === "platform" && to.layer === "app") return "platform-no-apps"
    if ((from.id.startsWith("packages/") || from.layer === "platform") && from.layer !== "facade" && to.layer === "facade") return "no-facade-backedge"
    return undefined
  }
  for (const edge of edges) {
    const from = byId.get(edge.source), to = byId.get(edge.target)
    if (!from || !to || from.test) continue
    const rule = ruleOf({ id: from.package, layer: from.layer }, { id: to.package, layer: to.layer })
    if (rule) violations.push({ rule, source: edge.source, target: edge.target, line: edge.line, message: `${from.package} imports ${to.package}` })
  }
  const byPackage = new Map(packages.map((pkg) => [pkg.id, pkg]))
  for (const pkg of packages) for (const target of pkg.dependencies) {
    const to = byPackage.get(target)
    if (!to) continue
    const rule = ruleOf(pkg, to)
    if (rule) violations.push({ rule: `manifest:${rule}`, source: `${pkg.id}/package.json`, target: `${target}/package.json`, line: 1, message: `${pkg.id} declares a production dependency on ${target}` })
  }
  const outgoing = groupBy(edges.filter((edge) => !edge.typeOnly && !byId.get(edge.target)?.test), (edge) => edge.source)
  const entryRules = [
    {
      start: "platform/bun/src/create-host.ts", rule: "host-without-http",
      forbidden: (id: string) => byId.get(id)?.package === "packages/http" || id.startsWith("packages/host/src/transport/http/")
    },
    {
      start: "packages/http/src/http.ts", rule: "http-without-agent-runtime",
      forbidden: (id: string) => id.startsWith("packages/agent/") &&
        !["packages/agent/src/inference/access.ts", "packages/agent/src/inference/reference.ts"].includes(id)
    }
  ]
  for (const { start, rule, forbidden } of entryRules) {
    const queue: string[][] = [[start]], seen = new Set([start])
    while (queue.length) {
      const path = queue.shift()!, last = path.at(-1)!
      for (const edge of outgoing.get(last) ?? []) {
        if (seen.has(edge.target)) continue
        seen.add(edge.target)
        const next = [...path, edge.target]
        if (forbidden(edge.target)) violations.push({ rule, source: start, target: edge.target, line: 1, message: next.join(" → ") })
        else queue.push(next)
      }
    }
  }
  return violations
}

const layerOf = (id: string): string => id.startsWith("platform/") ? "platform"
  : id.startsWith("apps/") || id.startsWith("examples/") ? "app"
  : id === "packages/tardie" ? "facade" : id.startsWith("packages/") ? id.split("/")[1]! : "tooling"

// analyzeGraph resolves working-tree source imports through Bun's workspace and TypeScript resolution.
export const analyzeGraph = async (root: string): Promise<GraphData> => {
  const command = (args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const files = command(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
    .filter((file) => existsSync(resolve(root, file)))
  const manifests = files.filter((file) => file.endsWith("/package.json") && !file.startsWith(".context/"))
  const rawPackages = await Promise.all(manifests.map(async (file) => {
    const raw = await Bun.file(resolve(root, file)).json() as { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    return { id: dirname(file), raw }
  }))
  const names = new Map(rawPackages.map(({ id, raw }) => [raw.name, id]))
  const packages: PackageNode[] = rawPackages.map(({ id, raw }) => ({ id, name: raw.name, layer: layerOf(id),
    dependencies: Object.keys(raw.dependencies ?? {}).flatMap((name) => names.has(name) ? [names.get(name)!] : []).sort(),
    devDependencies: Object.keys(raw.devDependencies ?? {}).flatMap((name) => names.has(name) ? [names.get(name)!] : []).sort()
  })).sort((a, b) => a.id.localeCompare(b.id))
  const owners = [...packages].sort((a, b) => b.id.length - a.id.length)
  const sourceFiles = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.endsWith(".d.ts"))
  const nodes: GraphNode[] = [], edges: GraphEdge[] = [], unresolved: GraphData["unresolved"] = []
  const sourceSet = new Set(sourceFiles)
  for (const file of sourceFiles.sort()) {
    const source = await Bun.file(resolve(root, file)).text()
    const owner = owners.find((pkg) => file.startsWith(pkg.id + "/"))
    const external = new Set<string>()
    nodes.push({ id: file, package: owner?.id ?? "tooling", layer: owner?.layer ?? "tooling",
      test: /(?:^|\/)(?:test|tests|e2e)(?:\/|$)|\.(?:test|spec|workers)\.[cm]?[jt]sx?$/.test(file),
      lines: source.split("\n").length, source, external: [] })
    for (const site of importsOf(file, source)) {
      if (site.specifier.startsWith("<computed")) { unresolved.push({ file, line: site.line, specifier: site.specifier }); continue }
      let target: string | undefined
      try { target = relative(root, realpathSync(Bun.resolveSync(site.specifier, resolve(root, dirname(file))))).replaceAll("\\", "/") } catch { /* Resolution gaps are listed below. */ }
      if (target && sourceSet.has(target)) edges.push({ source: file, target, ...site })
      else if (site.specifier.startsWith(".") || [...names.keys()].some((name) => site.specifier === name || site.specifier.startsWith(name + "/")) || site.specifier.startsWith("@/") || site.specifier.startsWith("~/")) {
        if (!target || !existsSync(resolve(root, target))) unresolved.push({ file, line: site.line, specifier: site.specifier })
      } else external.add(site.specifier)
    }
    nodes.at(-1)!.external.push(...[...external].sort())
  }
  return { generatedAt: new Date().toISOString(), commit: command(["git", "rev-parse", "--short", "HEAD"]), nodes, edges, packages,
    violations: boundaryViolations(nodes, edges, packages), cycles: cycleGroups(nodes, edges), unresolved }
}
