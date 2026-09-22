import { parseSync } from "oxc-parser"

type Node = Record<string, unknown>
export interface PurityViolation { readonly line: number; readonly api: string }
const nodeOf = (value: unknown): Node | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Node : undefined
const list = (value: unknown): ReadonlyArray<Node> => Array.isArray(value) ? value.flatMap<Node>((item) => { const node = nodeOf(item); return node === undefined ? [] : [node] }) : []
const isFunction = (node: Node): boolean => ["ArrowFunctionExpression", "FunctionExpression"].includes(String(node.type))
const ioModule = /^(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|http2|dns(?:\/promises)?|crypto|perf_hooks|timers(?:\/promises)?|os)$/
const deferredEffect = new Set(["sync", "suspend", "gen", "promise", "tryPromise", "try", "callback", "async", "map", "flatMap", "tap", "catch", "catchAll", "catchCause", "ensuring", "acquireRelease"])

// componentPurityViolations checks known impure APIs during component evaluation, preserving deferred work (component-purity.test.ts).
export const componentPurityViolations = (file: string, source: string): ReadonlyArray<PurityViolation> => {
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) throw new Error(`${file}: ${parsed.errors.map((error) => error.message).join("; ")}`)
  const aliases = new Map<string, string>()
  const constructors = new Set<string>()
  const functions = new Map<string, Node>()
  const visitedFunctions = new Set<Node>()
  const deferredFunctions = new Set<Node>()
  const violations = new Map<number, PurityViolation>()
  const nameOf = (value: unknown): string => {
    const node = nodeOf(value)
    if (!node) return ""
    if (node.type === "Identifier") return aliases.get(String(node.name)) ?? String(node.name)
    if (node.type === "ChainExpression" || node.type === "TSAsExpression" || node.type === "TSNonNullExpression") return nameOf(node.expression)
    if (node.type === "MemberExpression") {
      const property = nodeOf(node.property)
      const key = node.computed ? property?.value : property?.name
      return typeof key === "string" ? `${nameOf(node.object)}.${key}` : ""
    }
    return ""
  }
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return }
    const node = nodeOf(value)
    if (!node) return
    if (node.type === "ImportDeclaration" && node.importKind !== "type") {
      const module = String(nodeOf(node.source)?.value ?? "")
      for (const spec of list(node.specifiers)) {
        if (spec.importKind === "type") continue
        const local = String(nodeOf(spec.local)?.name)
        const imported = String(nodeOf(spec.imported)?.name ?? "")
        if (module.includes("tardigrade") || module.startsWith(".")) {
          if (["component", "legacyComponent"].includes(imported)) constructors.add(local)
        }
        if (module === "effect") aliases.set(local, imported || "EffectModule")
        if (ioModule.test(module) || module === "bun") aliases.set(local, `io:${module}.${imported}`)
      }
    }
    if (node.type === "VariableDeclarator") {
      const id = nodeOf(node.id), init = nodeOf(node.init)
      if (id?.type === "Identifier" && init) {
        const name = nameOf(init)
        if (name) aliases.set(String(id.name), name)
        if (isFunction(init)) functions.set(String(id.name), init)
      }
      if (id?.type === "ObjectPattern") for (const property of list(id.properties)) {
        const local = nodeOf(property.value), key = nodeOf(property.key)
        if (local?.type === "Identifier") aliases.set(String(local.name), `${nameOf(init)}.${key?.name ?? key?.value}`)
      }
    }
    if (node.type === "FunctionDeclaration") functions.set(String(nodeOf(node.id)?.name), node)
    for (const child of Object.values(node)) collect(child)
  }
  collect(parsed.program)
  const collectDeferred = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collectDeferred); return }
    const node = nodeOf(value)
    if (!node) return
    if (node.type === "CallExpression") {
      const name = nameOf(node.callee)
      const defer = (value: unknown): void => {
        const helper = functions.get(nameOf(value))
        if (helper) deferredFunctions.add(helper)
      }
      for (const arg of list(node.arguments)) {
        if (/^(Effect|EffectModule\.Effect)\./.test(name) && deferredEffect.has(name.split(".").at(-1)!)) defer(arg)
        if ((name.endsWith(".effect") || name === "effect") && arg.type === "ObjectExpression") {
          for (const property of list(arg.properties)) if (nodeOf(property.key)?.name === "act") defer(property.value)
        }
      }
    }
    for (const child of Object.values(node)) collectDeferred(child)
  }
  collectDeferred(parsed.program)
  const report = (node: Node, api: string): void => {
    const start = Number(node.start)
    violations.set(start, { line: source.slice(0, start).split("\n").length, api })
  }
  const forbidden = (raw: string): boolean => {
    const name = raw.replace(/^(globalThis|global|window)\./, "").replace(/^EffectModule\./, "")
    return /^(fetch|setTimeout|setInterval|setImmediate|queueMicrotask|require)$/.test(name) ||
      /^(Date\.now|Math\.random|performance\.(now|timeOrigin)|crypto\.(randomUUID|getRandomValues))$/.test(name) ||
      /^(Bun|Deno|console|process)\./.test(name) || name.startsWith("io:") ||
      /^(Effect|Runtime)\.run/.test(name)
  }
  const walk = (value: unknown, pure: boolean, effectObject = false): void => {
    if (Array.isArray(value)) { value.forEach((child) => walk(child, pure)); return }
    const node = nodeOf(value)
    if (!node) return
    if (deferredFunctions.has(node)) return
    if (String(node.type).startsWith("TS") && !["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"].includes(String(node.type))) return
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const name = nameOf(node.callee), args = list(node.arguments)
      if (pure && (forbidden(name) || (name === "Date" && (node.type === "CallExpression" || args.length === 0)) || (node.type === "NewExpression" && ["WebSocket", "EventSource", "Worker"].includes(name)))) report(node, name)
      if (pure && functions.has(name)) {
        const helper = functions.get(name)!
        if (!visitedFunctions.has(helper)) { visitedFunctions.add(helper); walk(helper.body, true) }
      }
      const factory = constructors.has(name)
      const effect = name.endsWith(".effect") || name === "effect"
      const deferred = /^(Effect|EffectModule\.Effect)\./.test(name) && deferredEffect.has(name.split(".").at(-1)!)
      walk(node.callee, pure)
      for (const arg of args) {
        if (deferred && isFunction(arg)) continue
        walk(arg, pure || factory, effect && arg.type === "ObjectExpression")
      }
      return
    }
    if (node.type === "ObjectExpression" && effectObject) {
      for (const property of list(node.properties)) {
        if (nodeOf(property.key)?.name === "act" && isFunction(nodeOf(property.value) ?? {})) continue
        walk(property, pure)
      }
      return
    }
    if (pure && node.type === "ImportExpression") report(node, "dynamic import")
    if (pure && node.type === "MemberExpression" && /^(process\.env|globalThis\.process\.env)(\.|$)/.test(nameOf(node))) report(node, "process.env")
    for (const child of Object.values(node)) walk(child, pure)
  }
  walk(parsed.program, /packages\/(core|agent)\/src\/component\//.test(file) && file !== "packages/core/src/component/runtime.ts")
  return [...violations.values()].sort((a, b) => a.line - b.line)
}
