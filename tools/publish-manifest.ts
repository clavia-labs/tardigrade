import manifest0 from "../packages/tardie/package.json"
import manifest1 from "../packages/agent/package.json"
import manifest2 from "../packages/core/package.json"
import manifest3 from "../packages/code/package.json"
import manifest4 from "../packages/host/package.json"
import manifest5 from "../packages/channels/package.json"
import manifest6 from "../packages/client/package.json"
import manifest7 from "../platform/bun/package.json"
import manifest8 from "../platform/worker-loader/package.json"
import manifest9 from "../platform/cloudflare/package.json"
import manifest10 from "../packages/model/package.json"
import manifest11 from "../packages/http/package.json"
import manifest12 from "../apps/server/package.json"
import manifest13 from "../apps/cli/package.json"

interface DependencyManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

export const publishSources = [
  { dir: "packages/tardie", namespace: "tardie", pkg: manifest0 },
  { dir: "packages/agent", namespace: "agent", pkg: manifest1 },
  { dir: "packages/core", namespace: "core", pkg: manifest2 },
  { dir: "packages/code", namespace: "code", pkg: manifest3 },
  { dir: "packages/host", namespace: "host", pkg: manifest4 },
  { dir: "packages/channels", namespace: "channels", pkg: manifest5 },
  { dir: "packages/client", namespace: "client", pkg: manifest6 },
  { dir: "platform/bun", namespace: "bun", pkg: manifest7 },
  { dir: "platform/worker-loader", namespace: "worker-loader", pkg: manifest8 },
  { dir: "platform/cloudflare", namespace: "cloudflare", pkg: manifest9 },
  { dir: "packages/model", namespace: "model", pkg: manifest10 },
  { dir: "packages/http", namespace: "http", pkg: manifest11 },
  { dir: "apps/server", namespace: "server", pkg: manifest12 },
  { dir: "apps/cli", namespace: "cli", pkg: manifest13 },
] as const

export const REQUIRED_PUBLISH_DEPENDENCIES = [
  "@cfworker/json-schema",
  "@effect/platform-bun",
  "@effect/platform-node-shared",
  "@effect/sql-sqlite-bun",
  "@effect/sql-sqlite-do",
  "@tardie/ai",
  "@tardie/ai-anthropic",
  "@tardie/ai-openai",
  "@tardie/ai-openai-compat",
  "@tardie/ai-openrouter",
  "effect",
  "jsonc-parser",
] as const

const dependencyUnion = (packages: ReadonlyArray<DependencyManifest>) => {
  const workspaceNames = new Set(packages.map((pkg) => pkg.name))
  const dependencies = new Map<string, string>()
  for (const pkg of packages) {
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (workspaceNames.has(name)) continue
      const previous = dependencies.get(name)
      if (previous !== undefined && previous !== version) {
        throw new Error(`dependency ${name} has versions ${previous} and ${version}`)
      }
      dependencies.set(name, version)
    }
  }
  return Object.fromEntries([...dependencies].sort(([left], [right]) => left.localeCompare(right)))
}

const optionalPeerUnion = (packages: ReadonlyArray<DependencyManifest>) => {
  const versions = new Map<string, string>()
  for (const pkg of packages) {
    for (const [name, version] of Object.entries(pkg.peerDependencies ?? {})) {
      if (pkg.peerDependenciesMeta?.[name]?.optional !== true) continue
      const previous = versions.get(name)
      if (previous !== undefined && previous !== version) {
        throw new Error(`optional peer ${name} has versions ${previous} and ${version}`)
      }
      versions.set(name, version)
    }
  }
  const peerDependencies = Object.fromEntries([...versions].sort(([left], [right]) => left.localeCompare(right)))
  const peerDependenciesMeta = Object.fromEntries(Object.keys(peerDependencies).map((name) => [name, { optional: true }]))
  return { peerDependencies, peerDependenciesMeta }
}

// publishDependencies rejects changes to the required dependency set before publication.
export const publishDependencies = (packages: ReadonlyArray<DependencyManifest>) => {
  const dependencies = dependencyUnion(packages)
  const allowed = new Set<string>(REQUIRED_PUBLISH_DEPENDENCIES)
  const added = Object.keys(dependencies).filter(name => !allowed.has(name))
  const removed = REQUIRED_PUBLISH_DEPENDENCIES.filter(name => !(name in dependencies))
  if (added.length > 0 || removed.length > 0) {
    throw new Error(`Required publication dependencies changed: added [${added.join(", ")}]; removed [${removed.join(", ")}]. Update REQUIRED_PUBLISH_DEPENDENCIES in tools/publish-manifest.ts to approve the change.`)
  }
  return { dependencies, ...optionalPeerUnion(packages) }
}
