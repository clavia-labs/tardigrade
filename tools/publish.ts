import { copyFile, mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

type PkgJson = {
  readonly name: string
  readonly version: string
}

const root = fileURLToPath(new URL("../", import.meta.url))
const dryRun = process.argv.includes("--dry-run")

// Dependency order: a tarball's workspace:* deps rewrite to this version, and
// the registry must already hold those names before a consumer can install.
const dirs = [
  "packages/core",
  "packages/code",
  "packages/host",
  "packages/agent",
  "platform/bun",
  "platform/model"
] as const

const npmMin = { maj: 11, min: 5, patch: 1 } as const

const readPkg = async (dir: string): Promise<PkgJson> => {
  const raw: unknown = await Bun.file(join(root, dir, "package.json")).json()
  if (typeof raw !== "object" || raw === null) throw new Error(`${dir}/package.json is not an object`)
  if (!("name" in raw) || !("version" in raw)) throw new Error(`${dir}/package.json is missing name or version`)
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${dir}/package.json is missing name or version`)
  }
  return { name: raw.name, version: raw.version }
}

const output = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}\n${stderr}`)
  return stdout.trim()
}

const run = async (cmd: string[], cwd: string) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

const parseNpm = (v: string) => {
  const [maj, min, patch] = v.trim().split(".").map((n) => Number(n))
  if (maj === undefined || min === undefined || patch === undefined || [maj, min, patch].some((n) => !Number.isFinite(n))) {
    throw new Error(`unreadable npm version: ${v}`)
  }
  return { maj, min, patch }
}

const npmAtLeast = (v: string, min: typeof npmMin) => {
  const n = parseNpm(v)
  if (n.maj !== min.maj) return n.maj > min.maj
  if (n.min !== min.min) return n.min > min.min
  return n.patch >= min.patch
}

const published = async (name: string, version: string) => {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`registry ${url} -> ${res.status}`)
  return true
}

const withCopied = async (from: string, to: string, body: () => Promise<void>) => {
  await copyFile(from, to)
  try {
    await body()
  } finally {
    await unlink(to)
  }
}

const pkgs = await Promise.all(dirs.map(async (dir) => ({ dir, ...(await readPkg(dir)) })))
const versions = new Set(pkgs.map((p) => p.version))
if (versions.size !== 1) throw new Error(`publish versions must match: ${pkgs.map((p) => `${p.name}@${p.version}`).join(", ")}`)
const version = pkgs[0]!.version

const tag = process.env.GITHUB_REF?.startsWith("refs/tags/v") ? process.env.GITHUB_REF.slice("refs/tags/v".length) : undefined
if (tag !== undefined && tag !== version) {
  throw new Error(`tag v${tag} does not match package version ${version}`)
}

if (process.env.GITHUB_ACTIONS === "true" && !dryRun) {
  const npmVersion = await output(["npm", "--version"], root)
  if (!npmAtLeast(npmVersion, npmMin)) {
    throw new Error(`trusted publishing needs npm >= ${npmMin.maj}.${npmMin.min}.${npmMin.patch}; this runner has ${npmVersion}`)
  }
}

const dest = await mkdtemp(join(tmpdir(), "tardigrade-pack-"))
const license = join(root, "LICENSE")
const readme = join(root, "README.md")

try {
  for (const pkg of pkgs) {
    const dir = join(root, pkg.dir)
    if (await published(pkg.name, pkg.version)) {
      console.log(`skip ${pkg.name}@${pkg.version} (already on the registry)`)
      continue
    }
    const pack = async () => {
      const filename = await output(["bun", "pm", "pack", "--destination", dest, "--quiet", "--ignore-scripts"], dir)
      const tarball = isAbsolute(filename) ? filename : join(dest, filename)
      const publish = ["npm", "publish", tarball, "--access", "public", ...(dryRun ? ["--dry-run"] : [])]
      console.log(`${dryRun ? "dry-run" : "publish"} ${pkg.name}@${pkg.version}`)
      await run(publish, root)
    }
    await withCopied(license, join(dir, "LICENSE"), async () => {
      if (pkg.name === "@clavia/tardigrade") {
        await withCopied(readme, join(dir, "README.md"), pack)
        return
      }
      await pack()
    })
  }
} finally {
  await rm(dest, { recursive: true, force: true })
}
