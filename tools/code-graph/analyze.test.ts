import { describe, expect, test } from "bun:test"
import { boundaryViolations, cycleGroups, importsOf } from "./analyze"
import type { GraphEdge, GraphNode, PackageNode } from "./types"

const node = (id: string, layer: string, test = false): GraphNode => ({
  id, package: id.split("/").slice(0, 2).join("/"), layer, test,
  lines: 1, source: "", external: []
})
const edge = (source: string, target: string, typeOnly = false): GraphEdge => ({
  source, target, typeOnly, specifier: target, line: 7, kind: "import"
})
const pkg = (id: string, layer: string, dependencies: string[] = [], devDependencies: string[] = []): PackageNode => ({
  id, name: id, layer, dependencies, devDependencies
})

describe("importsOf", () => {
  test("ignores fake imports in comments and strings while retaining source locations", () => {
    const source = [
      '// import hidden from "comment"',
      'const text = \'require("string")\'',
      '/* export * from "block" */',
      'import "side-effect"',
      'export { real } from "actual"'
    ].join("\n")
    expect(importsOf("sample.ts", source)).toEqual([
      { specifier: "side-effect", line: 4, kind: "import", typeOnly: false },
      { specifier: "actual", line: 5, kind: "export", typeOnly: false }
    ])
  })

  test("distinguishes erased type dependencies from mixed and value bindings", () => {
    const source = [
      'import type { Shape } from "shape"',
      'import { type Value, value } from "mixed"',
      'import { type Only } from "only"',
      'export type { Result } from "result"',
      'export { type Port, port } from "ports"',
      'export * from "barrel"',
      'type Deferred = import("deferred").Deferred'
    ].join("\n")
    expect(importsOf("sample.ts", source)).toEqual([
      { specifier: "shape", line: 1, kind: "import", typeOnly: true },
      { specifier: "mixed", line: 2, kind: "import", typeOnly: false },
      { specifier: "only", line: 3, kind: "import", typeOnly: true },
      { specifier: "result", line: 4, kind: "export", typeOnly: true },
      { specifier: "ports", line: 5, kind: "export", typeOnly: false },
      { specifier: "barrel", line: 6, kind: "export", typeOnly: false },
      { specifier: "deferred", line: 7, kind: "import", typeOnly: true }
    ])
  })

  test("records literal loading and makes computed loading visible", () => {
    expect(importsOf("sample.ts", [
      'const one = import("one")',
      'const two = require("two")',
      'const three = import(prefix + name)',
      'const four = require(name)',
      'loader.require("unrelated")'
    ].join("\n"))).toEqual([
      { specifier: "one", line: 1, kind: "dynamic", typeOnly: false },
      { specifier: "two", line: 2, kind: "require", typeOnly: false },
      { specifier: "<computed dynamic import>", line: 3, kind: "dynamic", typeOnly: false },
      { specifier: "<computed require>", line: 4, kind: "require", typeOnly: false }
    ])
  })

  test("refuses syntax errors instead of silently producing an incomplete graph", () => {
    expect(() => importsOf("broken.ts", "import { from")).toThrow("broken.ts")
  })
})

describe("cycleGroups", () => {
  test("finds complete components and self imports without merging a one-way dependency", () => {
    const nodes = ["a", "b", "c", "d", "e", "f"].map((id) => node(id, "core"))
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d"),
      edge("d", "e"), edge("e", "d"), edge("f", "f")]
    expect(cycleGroups(nodes, edges)).toEqual([["a", "b", "c"], ["d", "e"], ["f"]])
    expect(cycleGroups([...nodes].reverse(), [...edges].reverse())).toEqual(cycleGroups(nodes, edges))
  })

  test("excludes cycles that close through a test, erased type, or missing node", () => {
    const nodes = [node("a", "core"), node("b", "core"), node("spec", "core", true)]
    expect(cycleGroups(nodes, [edge("a", "b"), edge("b", "a", true),
      edge("b", "spec"), edge("spec", "a"), edge("a", "missing"), edge("missing", "a")])).toEqual([])
  })
})

describe("boundaryViolations", () => {
  const core = node("packages/core/src/actor.ts", "core")
  const host = node("packages/host/src/execution.ts", "host")
  const http = node("packages/http/src/server.ts", "http")
  const bun = node("platform/bun/src/serve.ts", "platform")
  const app = node("apps/server/src/index.ts", "app")
  const facade = node("packages/tardie/src/index.ts", "facade")
  const nodes = [core, host, http, bun, app, facade]

  test("allows consumers to depend inward and the facade to assemble public exports", () => {
    expect(boundaryViolations(nodes, [edge(host.id, core.id), edge(http.id, host.id),
      edge(bun.id, http.id), edge(app.id, bun.id), edge(facade.id, bun.id)], [])).toEqual([])
  })

  test("reports forbidden source dependencies with their original locations", () => {
    const forbidden = [edge(core.id, host.id), edge(host.id, http.id), edge(http.id, bun.id),
      edge(bun.id, app.id), edge(http.id, facade.id)]
    expect(boundaryViolations(nodes, forbidden, []).map(({ rule, source, target, line }) => ({ rule, source, target, line }))).toEqual([
      { rule: "core-only", source: core.id, target: host.id, line: 7 },
      { rule: "host-inward", source: host.id, target: http.id, line: 7 },
      { rule: "shared-portable", source: http.id, target: bun.id, line: 7 },
      { rule: "platform-no-apps", source: bun.id, target: app.id, line: 7 },
      { rule: "no-facade-backedge", source: http.id, target: facade.id, line: 7 }
    ])
  })

  test("checks type dependencies for layering but permits test harnesses to cross layers", () => {
    const spec = node("packages/core/src/actor.test.ts", "core", true)
    expect(boundaryViolations([...nodes, spec], [edge(core.id, host.id, true), edge(spec.id, bun.id)], [])
      .map((violation) => violation.rule)).toEqual(["core-only"])
  })

  test("checks production manifests even without source imports, excluding development tooling", () => {
    const packages = [pkg("packages/core", "core", [], ["platform/bun"]),
      pkg("packages/host", "host", ["packages/http"]), pkg("packages/http", "http"),
      pkg("platform/bun", "platform", ["apps/server"]), pkg("apps/server", "app")]
    expect(boundaryViolations([], [], packages).map(({ rule, source, target }) => ({ rule, source, target }))).toEqual([
      { rule: "manifest:host-inward", source: "packages/host/package.json", target: "packages/http/package.json" },
      { rule: "manifest:platform-no-apps", source: "platform/bun/package.json", target: "apps/server/package.json" }
    ])
  })

  test("detects HTTP loading through otherwise allowed transitive dependencies", () => {
    const start = node("platform/bun/src/create-host.ts", "platform")
    const helper = node("platform/bun/src/backend.ts", "platform")
    const violations = boundaryViolations([...nodes, start, helper], [edge(start.id, helper.id), edge(helper.id, http.id)], [])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: "host-without-http", source: start.id, target: http.id })
    expect(violations[0]!.message).toContain(helper.id)
    expect(boundaryViolations([...nodes, start], [edge(start.id, http.id)], [])
      .map((violation) => violation.rule)).toEqual(["host-without-http"])
  })

  test("does not count HTTP reached only through an erased type or test harness", () => {
    const start = node("platform/bun/src/create-host.ts", "platform")
    const spec = node("platform/bun/src/host.test.ts", "platform", true)
    expect(boundaryViolations([...nodes, start, spec], [edge(start.id, http.id, true),
      edge(start.id, spec.id), edge(spec.id, http.id)], [])).toEqual([])
  })
})

test("generic HTTP permits model policy data but rejects transitive agent execution", () => {
  const http = "packages/http/src/http.ts", catalog = "packages/model/src/catalog-page.ts"
  const policy = "packages/agent/src/inference/access.ts", runtime = "packages/agent/src/index.ts"
  const nodes = [node(http, "http"), node(catalog, "model"), node(policy, "agent"), node(runtime, "agent")]
  const edges = [edge(http, catalog), edge(catalog, policy)]
  expect(boundaryViolations(nodes, edges, [])).toEqual([])
  expect(boundaryViolations(nodes, [...edges, edge(catalog, runtime)], [])).toContainEqual({
    rule: "http-without-agent-runtime", source: http, target: runtime, line: 1,
    message: [http, catalog, runtime].join(" → ")
  })
})

test("local host invocation cannot import HTTP helpers from inside the host package", () => {
  const host = "platform/bun/src/create-host.ts", adapter = "packages/host/src/transport/http/method-request.ts"
  expect(boundaryViolations([node(host, "platform"), node(adapter, "host")], [edge(host, adapter)], [])).toContainEqual({
    rule: "host-without-http", source: host, target: adapter, line: 1, message: [host, adapter].join(" → ")
  })

})
