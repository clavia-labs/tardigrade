import { cp, lstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, sep } from "node:path"

const root = join(import.meta.dir, "..")
const exists = async (path: string) => lstat(path).then(() => true, () => false)
const candidates = [
  { executable: join(root, "node_modules/.bin/tsdown"), dependencies: join(root, "node_modules") },
  { executable: join(dirname(root), ".bin/tsdown"), dependencies: dirname(root) }
]
const buildTools = (
  await Promise.all(candidates.map(async (candidate) => ((await exists(candidate.executable)) ? candidate : undefined)))
).find(
  (candidate) => candidate !== undefined
)

if (buildTools === undefined) throw new Error("tsdown must be installed before building flamecast-core")

const buildIn = async (directory: string) => {
  const build = Bun.spawn([process.execPath, "--bun", buildTools.executable], {
    cwd: directory,
    stdout: "inherit",
    stderr: "inherit"
  })
  const exitCode = await build.exited
  if (exitCode !== 0) throw new Error(`tsdown exited ${exitCode}`)
  if (!(await exists(join(directory, "dist/core.d.ts")))) {
    throw new Error("build did not emit TypeScript declarations")
  }
}

if (!root.split(sep).includes("node_modules")) {
  await buildIn(root)
} else {
  // The declaration pass excludes sources under node_modules, where Git dependencies install.
  // An external staging tree lets the consumer build include declarations.
  const staging = await mkdtemp(join(tmpdir(), "flamecast-build-"))
  try {
    for (const path of ["package.json", "packages", "tsconfig.base.json", "tsconfig.build.json", "tsdown.config.ts"]) {
      await cp(join(root, path), join(staging, path), { recursive: true })
    }
    await symlink(
      buildTools.dependencies,
      join(staging, "node_modules"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await buildIn(staging)
    await rm(join(root, "dist"), { recursive: true, force: true })
    await cp(join(staging, "dist"), join(root, "dist"), { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
