import { mkdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { DEFAULT_PROJECT_CONFIG_PATH } from "@clavia/tardigrade-server/config"
import { CLOUDFLARE_MODEL_CATALOG_MIGRATION } from "@clavia/tardigrade-cloudflare/catalog-migration"
import { modelProviderModuleOf, type ModelProtocol } from "@clavia/tardigrade-model/providers/directory"

import { CELLD_PROJECT_CONFIG_PATH, celldConfigOf } from "./celld"
import { actorTemplate, DEFAULT_INIT_TEMPLATE, type InitTemplate } from "./template"
import type { SetupAnswers, SetupFiles } from "./setup"
import { dependencyVersionIn, versionIn } from "./version"
import { callCommand, RLM_ONBOARDING_BRIEF, shellWord } from "./workflow"
import { emptyModelLock, MODEL_LOCK_FILE, type ModelLock } from "./model-lock"

export const DEFAULT_ACTOR_ENTRY = "actor.ts"
export const DEFAULT_INIT_ACTOR_NAME = "my-agent"
export const DEFAULT_SERVER_ENTRY = "server.ts"
export const DEFAULT_WORKER_ENTRY = "worker.ts"
export const DEFAULT_PACKAGE_MANIFEST = "package.json"
export const DEFAULT_MODEL_LOCK = MODEL_LOCK_FILE
export const DEFAULT_CATALOG_MIGRATION = "migrations/0001_catalog.sql"
export const DISCORD_INVITE_URL = "https://discord.gg/Z74jwRxz4k"

export interface InitActorOptions {
  readonly cwd?: string
  readonly directory?: string
  readonly now?: Date
  readonly packageVersion?: string
  readonly modelProtocol?: ModelProtocol
  readonly modelProvider?: string
  readonly modelLock?: ModelLock
  readonly template?: InitTemplate
}

export interface InitializedActor {
  readonly template: InitTemplate
  readonly name: string
  readonly directory: string
  readonly entry: string
  readonly server: string
  readonly worker: string
  readonly manifest: string
  readonly celldManifest: string
  readonly packageManifest: string
  readonly modelLock: string
  readonly catalogMigration: string
}

export const defaultInitDirectory = (name: string): string => name

const manifestTemplate = (name: string, now: Date): string => `${JSON.stringify({
  $schema: "./node_modules/wrangler/config-schema.json",
  name,
  main: DEFAULT_WORKER_ENTRY,
  compatibility_date: now.toISOString().slice(0, 10),
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { name: "ACTORS", class_name: "ActorDO" },
      { name: "THREADS", class_name: "ThreadDO" }
    ]
  },
  worker_loaders: [{ binding: "LOADER" }],
  migrations: [{ tag: "v1", new_sqlite_classes: ["ActorDO", "ThreadDO"] }],
  d1_databases: [{
    binding: "CATALOG_DB",
    database_name: `${name}-catalog`,
    migrations_dir: "migrations"
  }],
  observability: { enabled: true },
  limits: { cpu_ms: 300_000 },
  vars: {
    TARDIGRADE_ALARM_DELAY_MILLIS: "120000",
    TARDIGRADE_COMPACTION_FIRE_RATIO: "0.8",
    TARDIGRADE_COMPACTION_KEEP_RATIO: "0.5",
    TARDIGRADE_MAX_CONCURRENT_THREADS: "4",
    TARDIGRADE_MODEL_CATALOG_URL: "https://models.dev/api.json",
    TARDIGRADE_MODEL_CATALOG_LOAD_POLICY: "refresh",
    TARDIGRADE_MODEL_CATALOG_TIMEOUT_MILLIS: "10000",
    TARDIGRADE_CONFIG: {}
  }
}, undefined, 2)}\n`

const workerTemplate = (provider: string): string => `import { providerLayer } from "tardie/model/providers/${provider}"
import definition from "./actor"
import { defineWorkerHost, workerHttp, workerModelServices, modelScopeFrom } from "tardie/worker"
import modelLock from "./models.lock.json"

const services = workerModelServices({
  model: { providerLayer },
  scope: modelScopeFrom(modelLock)
})

const host = defineWorkerHost(definition, { services })
const http = workerHttp(host)

export const { ActorDO, ThreadDO } = host

export default {
  fetch: http.fetch
}
`

const serverTemplate = (provider: string): string => `import { providerLayer } from "tardie/model/providers/${provider}"
import { createBunHost, serve } from "tardie/bun"
import { bunModelServices } from "tardie/server/model-services"
import definition from "./actor"

const { config, layers, api } = await bunModelServices({
  model: { providerLayer },
  env: process.env
})
const host = await createBunHost({
  actor: definition,
  storage: config.actorData,
  driver: { maxConcurrentThreads: config.maxConcurrentThreads },
  layersFor: () => layers
})

try {
  const server = await serve(host, { port: config.port, token: config.token, api })
  try {
    await new Promise<void>((resolve) => {
      const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve() }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } finally {
    await server.close()
  }
} finally {
  await host.close()
}
`

const packageTemplate = (
  version: string,
  effectVersion: string,
  platformBunVersion: string
): string => `${JSON.stringify({
  private: true,
  type: "module",
  scripts: {
    dev: `bun --env-file=.dev.vars --watch ${DEFAULT_SERVER_ENTRY}`,
    "dev:cloudflare": "wrangler dev",
    "deploy:cloudflare": "wrangler deploy",
    "deploy:celld": `celld deploy --config ${CELLD_PROJECT_CONFIG_PATH}`
  },
  dependencies: {
    "@effect/platform-bun": platformBunVersion,
    effect: effectVersion,
    tardie: version
  }
}, undefined, 2)}\n`

export const initActor = async (name: string, options: InitActorOptions): Promise<InitializedActor> => {
  const cwd = options.cwd ?? process.cwd()
  const directory = resolve(cwd, options.directory ?? defaultInitDirectory(name))
  const entry = resolve(directory, DEFAULT_ACTOR_ENTRY)
  const server = resolve(directory, DEFAULT_SERVER_ENTRY)
  const worker = resolve(directory, DEFAULT_WORKER_ENTRY)
  const manifest = resolve(directory, DEFAULT_PROJECT_CONFIG_PATH)
  const celldManifest = resolve(directory, CELLD_PROJECT_CONFIG_PATH)
  const packageManifest = resolve(directory, DEFAULT_PACKAGE_MANIFEST)
  const modelLock = resolve(directory, DEFAULT_MODEL_LOCK)
  const catalogMigration = resolve(directory, DEFAULT_CATALOG_MIGRATION)
  const source = await actorTemplate({
    name,
    ...(options.template === undefined ? {} : { template: options.template })
  })
  const manifestSource = manifestTemplate(name, options.now ?? new Date())
  const packageVersion = options.packageVersion ?? await versionIn(import.meta.url)
  if (packageVersion.endsWith("-unknown")) throw new Error("cannot determine the installed Tardigrade version")
  const effectVersion = await dependencyVersionIn("effect", import.meta.url)
  const platformBunVersion = await dependencyVersionIn("@effect/platform-bun", import.meta.url)
  if (effectVersion.endsWith("-unknown") || platformBunVersion.endsWith("-unknown")) {
    throw new Error("cannot determine the installed Effect versions")
  }

  const created = await mkdir(directory, { recursive: true })
  if (created === undefined) throw new Error(`init target already exists at ${directory}. Choose a new directory.`)

  try {
    await writeFile(entry, source, "utf8")
    await writeFile(server, serverTemplate(modelProviderModuleOf(options.modelProvider, options.modelProtocol ?? "openai-chat-completions")), "utf8")
    await writeFile(worker, workerTemplate(modelProviderModuleOf(options.modelProvider, options.modelProtocol ?? "openai-chat-completions")), "utf8")
    await writeFile(manifest, manifestSource, "utf8")
    await writeFile(celldManifest, celldConfigOf(manifestSource, manifest).source, "utf8")
    await writeFile(packageManifest, packageTemplate(packageVersion, effectVersion, platformBunVersion), "utf8")
    await writeFile(modelLock, `${JSON.stringify(options.modelLock ?? emptyModelLock(), null, 2)}\n`, "utf8")
    await mkdir(resolve(directory, "migrations"))
    await writeFile(catalogMigration, CLOUDFLARE_MODEL_CATALOG_MIGRATION, "utf8")
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }

  return { name, directory, entry, server, worker, manifest, celldManifest, packageManifest, modelLock, catalogMigration, template: options.template ?? DEFAULT_INIT_TEMPLATE }
}

const shownPath = (cwd: string, path: string): string => {
  const shown = relative(cwd, path)
  return shown.length === 0 ? "." : shown
}

export interface InitSummaryOptions {
  readonly colors?: boolean
  readonly cwd?: string
}

const styled = (value: string, codes: string, colors: boolean): string =>
  colors ? `\u001b[${codes}m${value}\u001b[0m` : value

const summaryField = (name: string, value: string, colors: boolean): string =>
  `  ${styled(name.padEnd(12), "2", colors)}${value}`

export const terminalColorsEnabled = (
  env: Readonly<Record<string, string | undefined>>,
  isTTY: boolean = process.stdout.isTTY === true
): boolean => isTTY && (env["NO_COLOR"]?.trim().length ?? 0) === 0

export const initSummary = (
  actor: InitializedActor,
  files: SetupFiles,
  answers: SetupAnswers,
  options: InitSummaryOptions = {}
): string => {
  const colors = options.colors ?? false
  const cwd = options.cwd ?? process.cwd()
  const directory = shownPath(cwd, actor.directory)
  const shownDirectory = directory.startsWith("/") || directory.startsWith(".") ? directory : `./${directory}`
  const credential = answers.credential === undefined
    ? `${answers.env.join(" or ")} (environment)`
    : `${answers.env[0]} (${shownPath(actor.directory, files.secretsPath)})`
  const lines = [
    styled(`✓ actor ${JSON.stringify(actor.name)} created in ${shownDirectory}`, "1;32", colors),
    summaryField("files", shownPath(actor.directory, actor.entry), colors),
    summaryField("", shownPath(actor.directory, actor.server), colors),
    summaryField("", shownPath(actor.directory, actor.worker), colors),
    summaryField("", shownPath(actor.directory, actor.manifest), colors),
    summaryField("", shownPath(actor.directory, actor.celldManifest), colors),
    summaryField("", shownPath(actor.directory, actor.packageManifest), colors),
    summaryField("", shownPath(actor.directory, actor.modelLock), colors),
    summaryField("", shownPath(actor.directory, actor.catalogMigration), colors),
    summaryField("credential", credential, colors),
    ...(answers.region === undefined ? [] : [summaryField("region", answers.region, colors)]),
    "",
    styled("→ next", "1;36", colors),
    `  cd ${shellWord(directory)}`,
    "  bun run dev",
    "",
    styled("→ call from another terminal", "1;36", colors),
    "  tdg thread create --name main",
    `  ${callCommand(actor.template === "rlm" ? RLM_ONBOARDING_BRIEF : undefined)}`,
    "",
    styled("↗ deploy", "1;36", colors),
    summaryField("Cloudflare", "bunx wrangler deploy", colors),
    summaryField("Celld", `celld deploy --config ${shellWord(shownPath(actor.directory, actor.celldManifest))}`, colors),
    "",
    styled("? help", "1;36", colors),
    `  ${DISCORD_INVITE_URL}`
  ]
  return `\n${lines.map((line) => line.length === 0 ? "" : `  ${line}`).join("\n")}\n`
}
