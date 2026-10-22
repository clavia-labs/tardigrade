import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { rewriteComponentRuntimeImports, stageInitTemplates } from "./publish-paths"
import publicExports from "./public-exports.json"
import { syncPublicExports } from "./public-exports"
import { publishDependencies, publishSources } from "./publish-manifest"

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

// The command the package installs, and the module it points at. One install gives the library, the
// server, the UI, and the command (sdk-and-cli-spec.md, "Phase 3").
const BIN_NAME = "tdg"

const BIN_ENTRY = "./src/deprecated/cli/main.ts"

const STAGED_EXAMPLES = "examples"


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

const verifyPackedManifest = async (tarball: string, expected: {
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly peerDependenciesMeta: Readonly<Record<string, { readonly optional?: boolean }>>
}) => {
  const packed = JSON.parse(await output(["tar", "-xOf", tarball, "package/package.json"], root)) as {
    readonly dependencies?: Readonly<Record<string, string>>
    readonly peerDependencies?: Readonly<Record<string, string>>
    readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  }
  for (const [name, expectedDependencies] of [["dependencies", expected.dependencies], ["peerDependencies", expected.peerDependencies], ["peerDependenciesMeta", expected.peerDependenciesMeta]] as const) {
    if (JSON.stringify(packed[name] ?? {}) !== JSON.stringify(expectedDependencies)) {
      throw new Error(`packed manifest ${name} differs from the publication manifest`)
    }
  }
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

const rewriteSources = async (dir: string, sourceRoot = dir): Promise<void> => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await rewriteSources(path, sourceRoot)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue
    let source = await readFile(path, "utf8")
    source = source.replace(/(["'])(@clavia\/[^"']+)\1/g, (match, quote: string, specifier: string) => {
      for (const source of publishSources) {
        if (specifier !== source.pkg.name && !specifier.startsWith(`${source.pkg.name}/`)) continue
        const key = specifier === source.pkg.name ? "." : `.${specifier.slice(source.pkg.name.length)}`
        const exports: Readonly<Record<string, string | null>> = source.pkg.exports
        let target = exports[key]
        if (target === undefined) {
          const pattern = Object.keys(exports).filter(key => key.includes("*")).sort((a, b) => b.length - a.length).find(pattern => {
            const [prefix, suffix] = pattern.split("*")
            return key.startsWith(prefix!) && key.endsWith(suffix!)
          })
          if (pattern !== undefined) {
            const [prefix, suffix] = pattern.split("*")
            target = exports[pattern]?.replace("*", key.slice(prefix!.length, suffix!.length === 0 ? undefined : -suffix!.length))
          }
        }
        if (target == null) throw new Error(`No workspace export for ${specifier} in ${path}`)
        const destination = relative(dirname(path), join(sourceRoot, source.namespace, target.replace(/^\.\/src\//, "").replace(/\.ts$/, "")))
        return `${quote}${destination.startsWith(".") ? destination : `./${destination}`}${quote}`
      }
      return match
    })
    await writeFile(path, rewriteComponentRuntimeImports(source, path, sourceRoot))
  }
}

await syncPublicExports(true)

const packages = publishSources
const publicSource = packages.find((source) => source.namespace === "tardie")!
const dependencies = publishDependencies(packages.map((source) => source.pkg))
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
  for (const source of packages) await mkdir(join(stage, "src", source.namespace), { recursive: true })
  await Promise.all([
    cp(join(root, "LICENSE"), join(stage, "LICENSE")),
    cp(join(root, "README.md"), join(stage, "README.md")),
    stageInitTemplates(root, stage),
    ...packages.map(async (source) => {
      await cp(join(root, source.dir, "src"), join(stage, "src", source.namespace), {
        recursive: true,
        filter: (path) => !path.endsWith(".test.ts") && path !== join(root, "packages/model/src/testing") && path !== join(root, "packages/tardie/src/generated")
      })
    })
  ])

  await rewriteSources(join(stage, "src"))

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
    files: ["src", STAGED_EXAMPLES],
    engines: publicSource.pkg.engines,
    type: "module",
    bin: { [BIN_NAME]: BIN_ENTRY },
    exports: publicExports,
    ...dependencies
  }
  await writeFile(join(stage, "package.json"), `${JSON.stringify(publishManifest, null, 2)}\n`)

  // The staged package validates public imports before packing (public-exports-smoke.ts).
  const stagedModules = join(stage, "node_modules")
  await symlink(join(root, "node_modules"), stagedModules, "dir")
  try {
    await run([process.execPath, join(root, "tools/public-exports-smoke.ts")], stage)
  } finally {
    await rm(stagedModules)
  }

  const filename = await output(["bun", "pm", "pack", "--destination", destination, "--quiet", "--ignore-scripts"], stage)
  const tarball = isAbsolute(filename) ? filename : join(destination, filename)
  await verifyPackedManifest(tarball, dependencies)
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
