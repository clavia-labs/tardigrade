import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type PkgJson = {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly [key: string]: unknown
}

const root = fileURLToPath(new URL("../", import.meta.url))
const dryRun = process.argv.includes("--dry-run")
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
  { dir: "platform/bun", namespace: "bun" },
  { dir: "platform/model", namespace: "model" }
] as const

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
const version = (await readPkg(".")).version
const prerelease = version.includes("-")
const distTag = option("--tag") ?? (prerelease ? DEFAULT_PRERELEASE_NPM_TAG : DEFAULT_STABLE_NPM_TAG)
if (prerelease && distTag === DEFAULT_STABLE_NPM_TAG) {
  throw new Error(`prerelease ${version} cannot use npm tag ${DEFAULT_STABLE_NPM_TAG}`)
}

const releaseTag = process.env.GITHUB_REF?.startsWith("refs/tags/v") ? process.env.GITHUB_REF.slice("refs/tags/v".length) : undefined
if (releaseTag !== undefined && releaseTag !== version) {
  throw new Error(`tag v${releaseTag} does not match package version ${version}`)
}

if (process.env.GITHUB_ACTIONS === "true" && !dryRun) {
  const npmVersion = await output(["npm", "--version"], root)
  if (!npmAtLeast(npmVersion, npmMin)) {
    throw new Error(`trusted publishing needs npm >= ${npmMin.maj}.${npmMin.min}.${npmMin.patch}; this runner has ${npmVersion}`)
  }
}

const alreadyPublished = await published(publicSource.pkg.name, version)
if (!dryRun && alreadyPublished) {
  console.log(`skip ${publicSource.pkg.name}@${version} (already on the registry)`)
  process.exit(0)
}

const requestedOutput = option("--output")
const destination = requestedOutput === undefined ? await mkdtemp(join(tmpdir(), "tardigrade-pack-")) : resolve(root, requestedOutput)
const temporary = requestedOutput === undefined
const stage = join(destination, "package")

try {
  await mkdir(stage, { recursive: true })
  await Promise.all([
    cp(join(root, "LICENSE"), join(stage, "LICENSE")),
    cp(join(root, "README.md"), join(stage, "README.md")),
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
    files: ["src"],
    engines: publicSource.pkg.engines,
    type: "module",
    exports: {
      ".": "./src/agent/index.ts",
      "./package.json": "./package.json",
      "./core/*": "./src/core/*.ts",
      "./code": "./src/code/index.ts",
      "./code/*": "./src/code/*.ts",
      "./host/*": "./src/host/*.ts",
      "./bun/*": "./src/bun/*.ts",
      "./model": "./src/model/model.ts",
      "./model/*": "./src/model/*.ts",
      "./*": "./src/agent/*.ts"
    },
    dependencies: dependencyUnion(packages.map((source) => source.pkg))
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)

  const filename = await output(["bun", "pm", "pack", "--destination", destination, "--quiet", "--ignore-scripts"], stage)
  const tarball = isAbsolute(filename) ? filename : join(destination, filename)
  const publish = ["npm", "publish", tarball, "--access", "public", "--tag", distTag, ...(dryRun ? ["--dry-run"] : [])]
  console.log(`${dryRun ? "dry-run" : "publish"} ${publicSource.pkg.name}@${version} with npm tag ${distTag}`)
  if (dryRun && alreadyPublished) {
    console.log(`skip npm dry-run validation (version already on the registry)`)
  } else {
    await run(publish, root)
  }
  if (requestedOutput !== undefined) console.log(`tarball ${tarball}`)
} finally {
  if (temporary) await rm(destination, { recursive: true, force: true })
}
