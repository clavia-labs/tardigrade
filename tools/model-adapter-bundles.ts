import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))

const run = async (command: ReadonlyArray<string>, cwd: string): Promise<void> => {
  const process = Bun.spawn([...command], { cwd, stdout: "inherit", stderr: "inherit" })
  const code = await process.exited
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`)
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const workerSource = (adapter: { readonly name: string; readonly source: string }): string => `import { actor } from "tardie"
import { ActorDO, ThreadDO, cloudflareWorker } from "tardie/cloudflare"
import { modelAdapters } from "tardie/model/adapter"
import { ${adapter.name} } from "${adapter.source}"

const definition = actor({ name: "bundle-proof", methods: {}, components: [] })

export { ActorDO, ThreadDO }
export default cloudflareWorker(definition, {
  modelAdapters: modelAdapters(${adapter.name})
})
`

const wranglerSource = `${JSON.stringify({
  name: "model-adapter-bundle-proof",
  main: "worker.ts",
  compatibility_date: "2026-08-28",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: { bindings: [
    { name: "ACTORS", class_name: "ActorDO" },
    { name: "THREADS", class_name: "ThreadDO" }
  ] },
  worker_loaders: [{ binding: "LOADER" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["ActorDO", "ThreadDO"] }],
  vars: { TARDIGRADE_CONFIG: {} }
}, undefined, 2)}\n`

interface PackedManifest {
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}

const main = async (): Promise<void> => {
  const temporary = await mkdtemp(join(tmpdir(), "tardigrade-model-bundles-"))
  try {
    const packed = join(temporary, "packed")
    await mkdir(packed)
    await run([process.execPath, "run", "tools/publish.ts", "--pack-only", "--output", packed], root)
    const tarballName = (await readdir(packed)).find((name) => name.endsWith(".tgz"))
    if (tarballName === undefined) throw new Error("packed Tardigrade tarball is missing")
    const tarball = join(packed, tarballName)

    const fixtures = [
      { name: "anthropic", adapter: { name: "anthropicAdapter", source: "tardie/model/anthropic" } },
      { name: "openai", adapter: { name: "openAICompatibleAdapter", source: "tardie/model/openai" } }
    ] as const

    let packedManifest: PackedManifest | undefined
    for (const fixture of fixtures) {
      const directory = join(temporary, fixture.name)
      await mkdir(directory)
      await writeFile(join(directory, "package.json"), `${JSON.stringify({
        private: true,
        type: "module",
        dependencies: { tardie: `file:${tarball}` }
      }, undefined, 2)}\n`)
      await writeFile(join(directory, "worker.ts"), workerSource(fixture.adapter))
      await writeFile(join(directory, "wrangler.jsonc"), wranglerSource)
      await run(["npm", "install", "--ignore-scripts", "--omit=optional"], directory)

      const manifest = JSON.parse(await readFile(join(directory, "node_modules/tardie/package.json"), "utf8")) as PackedManifest
      packedManifest = manifest
      const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, metadata]) => metadata.optional === true)
        .map(([name]) => name)
      if (optionalPeers.length === 0) throw new Error("packed Tardigrade manifest declares no optional provider dependencies")
      for (const name of optionalPeers) {
        const path = join(directory, "node_modules", ...name.split("/"))
        if (await exists(path)) throw new Error(`${fixture.name} installed optional provider dependency ${name}`)
      }

      await run([process.execPath, "-e", "await import('tardie/server/host')"], directory)
      await run([
        join(root, "node_modules/.bin/wrangler"),
        "deploy",
        "--dry-run",
        "--outdir",
        "dist",
        "--config",
        "wrangler.jsonc"
      ], directory)
      console.log(`${fixture.name} bundle excludes ${optionalPeers.length} optional provider dependencies`)
    }

    if (packedManifest === undefined) throw new Error("packed Tardigrade manifest was not read")
    const providerDependencies = packedManifest.peerDependencies ?? {}
    if (Object.keys(providerDependencies).length === 0) throw new Error("packed Tardigrade manifest declares no provider dependencies")
    const bedrockDirectory = join(temporary, "bedrock")
    await mkdir(bedrockDirectory)
    await writeFile(join(bedrockDirectory, "package.json"), `${JSON.stringify({
      private: true,
      type: "module",
      dependencies: { tardie: `file:${tarball}`, ...providerDependencies }
    }, undefined, 2)}\n`)
    await writeFile(join(bedrockDirectory, "worker.ts"), workerSource({ name: "bedrockAdapter", source: "tardie/model/bedrock" }))
    await writeFile(join(bedrockDirectory, "wrangler.jsonc"), wranglerSource)
    await run(["npm", "install", "--ignore-scripts"], bedrockDirectory)
    for (const name of Object.keys(providerDependencies)) {
      const path = join(bedrockDirectory, "node_modules", ...name.split("/"))
      if (!(await exists(path))) throw new Error(`bedrock did not install provider dependency ${name}`)
    }
    await run([
      join(root, "node_modules/.bin/wrangler"),
      "deploy",
      "--dry-run",
      "--outdir",
      "dist",
      "--config",
      "wrangler.jsonc"
    ], bedrockDirectory)
    console.log(`bedrock bundle includes ${Object.keys(providerDependencies).length} provider dependencies`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await main()
