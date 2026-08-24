import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { DEFAULT_PROJECT_CONFIG_PATH } from "@clavia/tardigrade-server/config"

import { CELLD_PROJECT_CONFIG_PATH, celldConfigOf } from "./celld"
import { actorTemplate, type ActorTemplateModel } from "./template"
import { versionIn } from "./version"
import { callCommandFor, shellWord } from "./workflow"

export const DEFAULT_ACTOR_ENTRY = "actor.ts"
export const DEFAULT_WORKER_ENTRY = "worker.ts"
export const DEFAULT_PACKAGE_MANIFEST = "package.json"

export interface InitActorOptions {
  readonly model: ActorTemplateModel
  readonly cwd?: string
  readonly directory?: string
  readonly force?: boolean
  readonly now?: Date
  readonly packageVersion?: string
}

export interface InitializedActor {
  readonly name: string
  readonly directory: string
  readonly entry: string
  readonly worker: string
  readonly manifest: string
  readonly celldManifest: string
  readonly packageManifest: string
}

export const defaultInitDirectory = (name: string): string => name

const manifestTemplate = (name: string, now: Date): string => `${JSON.stringify({
  $schema: "./node_modules/wrangler/config-schema.json",
  name,
  main: DEFAULT_WORKER_ENTRY,
  compatibility_date: now.toISOString().slice(0, 10),
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [{ name: "ACTORS", class_name: "ActorHost" }]
  },
  worker_loaders: [{ binding: "LOADER" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["ActorHost"] }],
  observability: { enabled: true },
  limits: { cpu_ms: 300_000 },
  vars: {
    TARDIGRADE_ALARM_DELAY_MILLIS: "120000",
    TARDIGRADE_COMPACTION_FIRE_RATIO: "0.8",
    TARDIGRADE_COMPACTION_KEEP_RATIO: "0.5",
    TARDIGRADE_MAX_CONCURRENT_LANES: "4",
    TARDIGRADE_MODEL_CATALOG_URL: "https://models.dev/api.json",
    TARDIGRADE_MODEL_CATALOG_LOAD_POLICY: "refresh",
    TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS: "10000",
    TARDIGRADE_CONFIG: {}
  }
}, undefined, 2)}\n`

const workerTemplate = `import definition from "./actor"
import { ActorHost, cloudflareWorker } from "tardie/cloudflare"

export { ActorHost }
export default cloudflareWorker(definition)
`

const packageTemplate = (version: string): string => `${JSON.stringify({
  private: true,
  type: "module",
  dependencies: { tardie: version }
}, undefined, 2)}\n`

const existsError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"

export const initActor = async (name: string, options: InitActorOptions): Promise<InitializedActor> => {
  const cwd = options.cwd ?? process.cwd()
  const directory = resolve(cwd, options.directory ?? defaultInitDirectory(name))
  const entry = resolve(directory, DEFAULT_ACTOR_ENTRY)
  const worker = resolve(directory, DEFAULT_WORKER_ENTRY)
  const manifest = resolve(directory, DEFAULT_PROJECT_CONFIG_PATH)
  const celldManifest = resolve(directory, CELLD_PROJECT_CONFIG_PATH)
  const packageManifest = resolve(directory, DEFAULT_PACKAGE_MANIFEST)
  const source = await actorTemplate({ name, model: options.model })
  const manifestSource = manifestTemplate(name, options.now ?? new Date())
  const packageVersion = options.packageVersion ?? await versionIn(import.meta.url)
  if (packageVersion.endsWith("-unknown")) throw new Error("cannot determine the installed Tardigrade version")

  await mkdir(dirname(entry), { recursive: true })
  try {
    await writeFile(entry, source, { encoding: "utf8", flag: options.force === true ? "w" : "wx" })
  } catch (error) {
    if (existsError(error)) {
      throw new Error(`actor already exists at ${entry}. Choose another directory or pass --force.`)
    }
    throw error
  }

  try {
    await writeFile(worker, workerTemplate, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!existsError(error)) throw error
  }

  try {
    await writeFile(manifest, manifestSource, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!existsError(error)) throw error
  }

  try {
    const currentManifest = await readFile(manifest, "utf8")
    await writeFile(celldManifest, celldConfigOf(currentManifest, manifest).source, { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!existsError(error)) throw error
  }

  try {
    await writeFile(packageManifest, packageTemplate(packageVersion), { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!existsError(error)) throw error
    const current = JSON.parse(await readFile(packageManifest, "utf8")) as Record<string, unknown>
    const dependencies = current["dependencies"]
    if (dependencies !== undefined && (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))) {
      throw new Error(`${packageManifest} dependencies must contain a JSON object`)
    }
    await writeFile(packageManifest, `${JSON.stringify({
      ...current,
      dependencies: { ...(dependencies as Record<string, unknown> | undefined), tardie: packageVersion }
    }, undefined, 2)}\n`)
  }

  return { name, directory, entry, worker, manifest, celldManifest, packageManifest }
}

const shownPath = (cwd: string, path: string): string => {
  const shown = relative(cwd, path)
  return shown.length === 0 ? "." : shown
}

export const initSummary = (actor: InitializedActor, cwd: string = process.cwd()): string => {
  const directory = shownPath(cwd, actor.directory)
  return [
    `created ${shownPath(cwd, actor.entry)}`,
    `created ${shownPath(cwd, actor.worker)}`,
    `created ${shownPath(cwd, actor.manifest)}`,
    `created ${shownPath(cwd, actor.celldManifest)}`,
    `created ${shownPath(cwd, actor.packageManifest)}`,
    "",
    "next",
    `  cd ${shellWord(directory)}`,
    "  tdg dev",
    "",
    "then, in another terminal",
    `  ${callCommandFor(actor.name)}`,
    "",
    "deploy to Cloudflare",
    "  bunx wrangler deploy",
    "",
    "deploy to Celld",
    `  celld deploy --config ${shellWord(shownPath(actor.directory, actor.celldManifest))}`
  ].join("\n")
}
