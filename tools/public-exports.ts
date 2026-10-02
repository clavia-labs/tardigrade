import { dirname, join, relative } from "node:path"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import publicExports from "./public-exports.json"
import { publishSources } from "./publish-manifest"

const root = fileURLToPath(new URL("../", import.meta.url))

// workspaceExports maps the public entrypoints to facade modules generated from public-exports.json.
export const workspaceExports = Object.fromEntries(Object.entries(publicExports).map(([key, target]) => [key,
  target === null || key === "./package.json" ? target : target.startsWith("./src/tardie/") ? target.replace("./src/tardie/", "./src/") : `./src/generated/${key.slice(2)}.ts`
]))

const facadeEntries = () => {
  const entries = new Map<string, string | null>()
  for (const [key, target] of Object.entries(publicExports)) {
    if (target === null || !key.includes("*")) continue
    const source = publishSources.filter(source => target.startsWith(`./src/${source.namespace}/`)).sort((a, b) => b.namespace.length - a.namespace.length)[0]
    if (source === undefined) throw new Error(`No publication source for ${target}`)
    const [prefix, suffix] = target.split("*")
    for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: join(root, source.dir, "src"), onlyFiles: true })) {
      if (file.endsWith(".test.ts") || file.startsWith("testing/") && source.namespace === "model") continue
      const resolved = `./src/${source.namespace}/${file}`
      if (!resolved.startsWith(prefix!) || !resolved.endsWith(suffix!)) continue
      const tail = resolved.slice(prefix!.length, suffix!.length === 0 ? undefined : -suffix!.length)
      entries.set(key.replace("*", tail), resolved)
    }
  }
  for (const [key, target] of Object.entries(publicExports)) if (!key.includes("*")) entries.set(key, target)
  return entries
}

// syncPublicExports generates workspace facades or checks them against the publication contract.
export async function syncPublicExports(check = false) {
  const manifestPath = join(root, "packages/tardie/package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { exports: typeof workspaceExports; dependencies: Record<string, string> }
  const dependencies = new Set<string>()
  if (!check) await rm(join(root, "packages/tardie/src/generated"), { recursive: true, force: true })
  for (const [key, target] of facadeEntries()) {
    if (target === null || key === "./package.json") continue
    if (target.startsWith("./src/tardie/")) continue
    const source = publishSources.filter(source => target.startsWith(`./src/${source.namespace}/`)).sort((a, b) => b.namespace.length - a.namespace.length)[0]
    if (source === undefined) throw new Error(`No publication source for ${target}`)
    const file = join(root, "packages/tardie", workspaceExports[key] ?? `./src/generated/${key.slice(2)}.ts`)
    const module = target.slice(`./src/${source.namespace}/`.length)
    const exports: Readonly<Record<string, string | null>> = source.pkg.exports
    const sourceTarget = `./src/${module}`
    let subpath = Object.keys(exports).find(key => exports[key] === sourceTarget)
    if (subpath === undefined) {
      for (const [pattern, target] of Object.entries(exports)) {
        if (target === null || !pattern.includes("*") || !target.includes("*")) continue
        const [prefix, suffix] = target.split("*")
        if (sourceTarget.startsWith(prefix!) && sourceTarget.endsWith(suffix!)) {
          subpath = pattern.replace("*", sourceTarget.slice(prefix!.length, suffix!.length === 0 ? undefined : -suffix!.length))
          break
        }
      }
    }
    const destination = relative(dirname(file), join(root, source.dir, "src", module)).replace(/\.ts$/, "")
    const specifier = subpath === undefined ? destination.startsWith(".") ? destination : `./${destination}` : `${source.pkg.name}${subpath === "." ? "" : subpath.slice(1)}`
    const content = `export * from "${specifier}"\n`
    if (source.namespace !== "tardie") dependencies.add(source.pkg.name)
    if (check) {
      if (await readFile(file, "utf8") !== content) throw new Error(`Run bun run exports to update ${relative(root, file)}`)
    } else {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content)
    }
  }
  if (check) {
    if (JSON.stringify(manifest.exports) !== JSON.stringify(workspaceExports)) throw new Error("Run bun run exports to update the workspace export map")
    for (const name of dependencies) if (manifest.dependencies[name] !== "workspace:*") throw new Error(`Missing facade dependency ${name}`)
  } else {
    manifest.exports = workspaceExports
    for (const name of dependencies) manifest.dependencies[name] = "workspace:*"
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}

if (import.meta.main) await syncPublicExports(process.argv.includes("--check"))
