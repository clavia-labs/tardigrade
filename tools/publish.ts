import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { INIT_TEMPLATES } from "../apps/cli/src/template"

type PkgJson = {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly [key: string]: unknown
}

const root = fileURLToPath(new URL("../", import.meta.url))
const dryRun = process.argv.includes("--dry-run")
const packOnly = process.argv.includes("--pack-only")
export const DEFAULT_STABLE_NPM_TAG = "latest"
export const DEFAULT_PRERELEASE_NPM_TAG = "next"

const option = (name: string) => {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

const sources = [
  { dir: "packages/agent", namespace: "agent" },
  { dir: "packages/core", namespace: "core" },
  { dir: "packages/code", namespace: "code" },
  { dir: "packages/host", namespace: "host" },
  { dir: "packages/channels", namespace: "channels" },
  { dir: "packages/client", namespace: "client" },
  { dir: "platform/bun", namespace: "bun" },
  { dir: "platform/worker-loader", namespace: "worker-loader" },
  { dir: "platform/cloudflare", namespace: "cloudflare" },
  { dir: "platform/model", namespace: "model" },
  { dir: "apps/server", namespace: "server" },
  { dir: "apps/cli", namespace: "cli" }
] as const

// The command the package installs, and the module it points at. One install gives the library, the
// server, the UI, and the command (sdk-and-cli-spec.md, "Phase 3").
const BIN_NAME = "tdg"

const BIN_ENTRY = "./src/cli/main.ts"

// Where the UI's build is staged, and where it comes from. `tdg dev` resolves this directory
// relative to its own module, so a published command finds the build with no configuration. The
// name is not the workspace directory's, so the candidate this command tries inside the repository
// cannot match it (apps/cli/src/assets.ts, INSTALLED_ASSETS).
const STAGED_ASSETS = "ui"
const STAGED_EXAMPLES = "examples"

const VOYAGER_SOURCE = "apps/voyager/dist"
const VOYAGER_BUILD = ["bun", "run", "--cwd", "apps/voyager", "build"]

const npmMin = { maj: 11, min: 5, patch: 1 } as const

const readPkg = async (dir: string): Promise<PkgJson> => {
  const raw: unknown = await Bun.file(join(root, dir, "package.json")).json()
  if (typeof raw !== "object" || raw === null) throw new Error(`${dir}/package.json is not an object`)
  if (!("name" in raw) || !("version" in raw)) throw new Error(`${dir}/package.json is missing name or version`)
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${dir}/package.json is missing name or version`)
  }
  return raw as PkgJson
}

const output = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr}`)
  return stdout.trim()
}

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

const parseNpm = (version: string) => {
  const [maj, min, patch] = version.trim().split(".").map((part) => Number(part))
  if (maj === undefined || min === undefined || patch === undefined || [maj, min, patch].some((part) => !Number.isFinite(part))) {
    throw new Error(`unreadable npm version: ${version}`)
  }
  return { maj, min, patch }
}

const npmAtLeast = (version: string, min: typeof npmMin) => {
  const found = parseNpm(version)
  if (found.maj !== min.maj) return found.maj > min.maj
  if (found.min !== min.min) return found.min > min.min
  return found.patch >= min.patch
}

const published = async (name: string, version: string) => {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const response = await fetch(url, { headers: { accept: "application/json" } })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`registry ${url} -> ${response.status}`)
  return true
}

const dependencyUnion = (packages: ReadonlyArray<PkgJson>) => {
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

const optionalPeerUnion = (packages: ReadonlyArray<PkgJson>) => {
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

const rewriteSources = async (dir: string, rewrites: ReadonlyMap<string, string>): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteSources(path, rewrites)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
    let source = await readFile(path, "utf8")
    for (const [from, to] of rewrites) {
      source = source.replaceAll(`${from}/`, `${to}/`).replaceAll(`"${from}"`, `"${to}"`).replaceAll(`'${from}'`, `'${to}'`)
    }
    await writeFile(path, source)
  }
}

const packages = await Promise.all(sources.map(async (source) => ({ ...source, pkg: await readPkg(source.dir) })))
const publicSource = packages.find((source) => source.namespace === "agent")!
const optionalPeers = optionalPeerUnion(packages.map((source) => source.pkg))
const version = option("--version") ?? (await readPkg(".")).version
const sourceTree = option("--source-tree")
const prerelease = version.includes("-")
const distTag = option("--tag") ?? (prerelease ? DEFAULT_PRERELEASE_NPM_TAG : DEFAULT_STABLE_NPM_TAG)
if (prerelease && distTag === DEFAULT_STABLE_NPM_TAG) {
  throw new Error(`prerelease ${version} cannot use npm tag ${DEFAULT_STABLE_NPM_TAG}`)
}

const releaseTag = process.env.GITHUB_REF?.startsWith("refs/tags/v") ? process.env.GITHUB_REF.slice("refs/tags/v".length) : undefined
if (releaseTag !== undefined && releaseTag !== version) {
  throw new Error(`tag v${releaseTag} does not match package version ${version}`)
}

if (process.env.GITHUB_ACTIONS === "true" && !dryRun && !packOnly) {
  const npmVersion = await output(["npm", "--version"], root)
  if (!npmAtLeast(npmVersion, npmMin)) {
    throw new Error(`trusted publishing needs npm >= ${npmMin.maj}.${npmMin.min}.${npmMin.patch}; this runner has ${npmVersion}`)
  }
}

const alreadyPublished = packOnly ? false : await published(publicSource.pkg.name, version)
if (!packOnly && !dryRun && alreadyPublished) {
  console.log(`skip ${publicSource.pkg.name}@${version} (already on the registry)`)
  process.exit(0)
}

const requestedOutput = option("--output")
const destination = requestedOutput === undefined ? await mkdtemp(join(tmpdir(), "tardigrade-pack-")) : resolve(root, requestedOutput)
const temporary = requestedOutput === undefined
const stage = join(destination, "package")

try {
  await mkdir(stage, { recursive: true })
  // The UI is built here rather than assumed: the tarball carries the assets `tdg dev` serves, and
  // a stale build shipped as a fresh one is worse than the wait.
  await run(VOYAGER_BUILD, root)
  await Promise.all([
    cp(join(root, "LICENSE"), join(stage, "LICENSE")),
    cp(join(root, "README.md"), join(stage, "README.md")),
    cp(join(root, VOYAGER_SOURCE), join(stage, STAGED_ASSETS), { recursive: true }),
    ...INIT_TEMPLATES.map((template) =>
      cp(join(root, "examples", template), join(stage, STAGED_EXAMPLES, template), { recursive: true })
    ),
    ...packages.map(async (source) => {
      await cp(join(root, source.dir, "src"), join(stage, "src", source.namespace), {
        recursive: true,
        filter: (path) => !path.endsWith(".test.ts")
      })
    })
  ])

  const rewrites = new Map(
    packages
      .filter((source) => source.namespace !== "agent")
      .map((source) => [source.pkg.name, `${publicSource.pkg.name}/${source.namespace}`] as const)
  )
  await rewriteSources(join(stage, "src"), rewrites)

  const repository = publicSource.pkg.repository
  const publishManifest = {
    name: publicSource.pkg.name,
    version,
    license: publicSource.pkg.license,
    author: publicSource.pkg.author,
    description: publicSource.pkg.description,
    homepage: publicSource.pkg.homepage,
    repository:
      typeof repository === "object" && repository !== null && "type" in repository && "url" in repository
        ? { type: repository.type, url: repository.url }
        : repository,
    bugs: publicSource.pkg.bugs,
    publishConfig: publicSource.pkg.publishConfig,
    ...(sourceTree === undefined ? {} : { tardigrade: { sourceTree } }),
    files: ["src", STAGED_ASSETS, STAGED_EXAMPLES],
    engines: publicSource.pkg.engines,
    type: "module",
    bin: { [BIN_NAME]: BIN_ENTRY },
    exports: {
      ".": "./src/agent/index.ts",
      "./package.json": "./package.json",
      "./actor/*": "./src/agent/actor/*.ts",
      "./component/*": "./src/agent/component/*.ts",
      "./inference/*": "./src/agent/inference/*.ts",
      "./log/*": "./src/agent/log/*.ts",
      "./output/*": "./src/agent/output/*.ts",
      "./packages/*": "./src/agent/packages/*.ts",
      "./projection/*": "./src/agent/projection/*.ts",
      "./runtime/*": "./src/agent/runtime/*.ts",
      "./core/actor": "./src/core/actor/index.ts",
      "./core/actor/*": "./src/core/actor/*.ts",
      "./core/actor/method": "./src/core/actor/method/index.ts",
      "./core/actor/method/*": "./src/core/actor/method/*.ts",
      "./core/communication": "./src/core/communication/index.ts",
      "./core/communication/*": "./src/core/communication/*.ts",
      "./core/component": "./src/core/component/index.ts",
      "./core/component/*": "./src/core/component/*.ts",
      "./core/effect": "./src/core/effect/effect.ts",
      "./core/effect/*": "./src/core/effect/*.ts",
      "./core/event": "./src/core/event/event.ts",
      "./core/event/*": "./src/core/event/*.ts",
      "./core/intent": "./src/core/intent/intent.ts",
      "./core/intent/*": "./src/core/intent/*.ts",
      "./core/log": "./src/core/log/index.ts",
      "./core/log/event": "./src/core/event/event.ts",
      "./core/log/*": "./src/core/log/*.ts",
      "./core/machine": "./src/core/machine/machine.ts",
      "./core/machine/*": "./src/core/machine/*.ts",
      "./core/projection": "./src/core/projection/projection.ts",
      "./core/projection/*": "./src/core/projection/*.ts",
      "./core/reconciliation": "./src/core/runtime/index.ts",
      "./core/reconciliation/reconciler": "./src/core/runtime/reconciler.ts",
      "./core/reconciliation/transition": "./src/core/transition/transition.ts",
      "./core/runtime": "./src/core/runtime/index.ts",
      "./core/runtime/*": "./src/core/runtime/*.ts",
      "./core/thread": "./src/core/thread/index.ts",
      "./core/thread/*": "./src/core/thread/*.ts",
      "./core/transition": "./src/core/transition/transition.ts",
      "./core/transition/*": "./src/core/transition/*.ts",
      "./core/view": "./src/core/view/view.ts",
      "./core/view/*": "./src/core/view/*.ts",
      "./code/execution/*": "./src/code/execution/*.ts",
      "./code/package/*": "./src/code/package/*.ts",
      "./code/sandbox/*": "./src/code/sandbox/*.ts",
      "./code/storage/*": "./src/code/storage/*.ts",
      "./host/*": "./src/host/*.ts",
      "./channels": "./src/channels/index.ts",
      "./channels/*": "./src/channels/*.ts",
      "./client": "./src/client/index.ts",
      "./client/*": "./src/client/*.ts",
      "./bun/*": "./src/bun/*.ts",
      "./worker-loader/*": "./src/worker-loader/*.ts",
      "./cloudflare": "./src/cloudflare/index.ts",
      "./cloudflare/*": "./src/cloudflare/*.ts",
      "./server/*": "./src/server/*.ts",
      "./cli/*": "./src/cli/*.ts",
      "./model": "./src/model/model.ts",
      "./model/*": "./src/model/*.ts"
    },
    dependencies: dependencyUnion(packages.map((source) => source.pkg)),
    peerDependencies: optionalPeers.peerDependencies,
    peerDependenciesMeta: optionalPeers.peerDependenciesMeta
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)

  // The staged package must resolve its rewritten self-imports through the public export map.
  const stagedModules = join(stage, "node_modules")
  await symlink(join(root, "node_modules"), stagedModules, "dir")
  try {
    await run([process.execPath, "-e", "await import('tardie')"], stage)
  } finally {
    await rm(stagedModules)
  }

  const filename = await output(["bun", "pm", "pack", "--destination", destination, "--quiet", "--ignore-scripts"], stage)
  const tarball = isAbsolute(filename) ? filename : join(destination, filename)
  if (packOnly) {
    console.log(`pack ${publicSource.pkg.name}@${version}`)
  } else {
    const publish = ["npm", "publish", tarball, "--access", "public", "--tag", distTag, ...(dryRun ? ["--dry-run"] : [])]
    console.log(`${dryRun ? "dry-run" : "publish"} ${publicSource.pkg.name}@${version} with npm tag ${distTag}`)
    if (dryRun && alreadyPublished) {
      console.log(`skip npm dry-run validation (version already on the registry)`)
    } else {
      await run(publish, root)
    }
  }
  if (requestedOutput !== undefined) console.log(`tarball ${tarball}`)
} finally {
  if (temporary) await rm(destination, { recursive: true, force: true })
}
