import { mkdir, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { DEFAULT_PROJECT_CONFIG_PATH } from "@clavia/tardigrade-server/config"
import type { ModelProtocol } from "@clavia/tardigrade-model/directory"

import { CELLD_PROJECT_CONFIG_PATH, celldConfigOf } from "./celld"
import { actorTemplate } from "./template"
import type { SetupAnswers, SetupFiles } from "./setup"
import { versionIn } from "./version"
import { callCommand, shellWord } from "./workflow"

export const DEFAULT_ACTOR_ENTRY = "actor.ts"
export const DEFAULT_WORKER_ENTRY = "worker.ts"
export const DEFAULT_PACKAGE_MANIFEST = "package.json"
export const DISCORD_INVITE_URL = "https://discord.gg/Z74jwRxz4k"

export interface InitActorOptions {
  readonly cwd?: string
  readonly directory?: string
  readonly now?: Date
  readonly packageVersion?: string
  readonly modelProtocol?: ModelProtocol
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

const adapterFor = (protocol: ModelProtocol): { readonly name: string; readonly source: string } => {
  switch (protocol) {
    case "anthropic-messages":
      return { name: "anthropicAdapter", source: "tardie/model/anthropic" }
    case "bedrock-converse":
      return { name: "bedrockAdapter", source: "tardie/model/bedrock" }
    case "openai-responses":
    case "openai-chat-completions":
      return { name: "openAICompatibleAdapter", source: "tardie/model/openai" }
  }
}

const workerTemplate = (protocol: ModelProtocol): string => {
  const adapter = adapterFor(protocol)
  return `import definition from "./actor"
import { ActorHost, cloudflareWorker } from "tardie/cloudflare"
import { modelAdapters } from "tardie/model/adapter"
import { ${adapter.name} } from "${adapter.source}"

export { ActorHost }
export default cloudflareWorker(definition, {
  modelAdapters: modelAdapters(${adapter.name})
})
`
}

const packageTemplate = (version: string): string => `${JSON.stringify({
  private: true,
  type: "module",
  dependencies: { tardie: version }
}, undefined, 2)}\n`

export const initActor = async (name: string, options: InitActorOptions): Promise<InitializedActor> => {
  const cwd = options.cwd ?? process.cwd()
  const directory = resolve(cwd, options.directory ?? defaultInitDirectory(name))
  const entry = resolve(directory, DEFAULT_ACTOR_ENTRY)
  const worker = resolve(directory, DEFAULT_WORKER_ENTRY)
  const manifest = resolve(directory, DEFAULT_PROJECT_CONFIG_PATH)
  const celldManifest = resolve(directory, CELLD_PROJECT_CONFIG_PATH)
  const packageManifest = resolve(directory, DEFAULT_PACKAGE_MANIFEST)
  const source = await actorTemplate({ name })
  const manifestSource = manifestTemplate(name, options.now ?? new Date())
  const packageVersion = options.packageVersion ?? await versionIn(import.meta.url)
  if (packageVersion.endsWith("-unknown")) throw new Error("cannot determine the installed Tardigrade version")

  const created = await mkdir(directory, { recursive: true })
  if (created === undefined) throw new Error(`init target already exists at ${directory}. Choose a new directory.`)

  try {
    await writeFile(entry, source, "utf8")
    await writeFile(worker, workerTemplate(options.modelProtocol ?? "openai-chat-completions"), "utf8")
    await writeFile(manifest, manifestSource, "utf8")
    await writeFile(celldManifest, celldConfigOf(manifestSource, manifest).source, "utf8")
    await writeFile(packageManifest, packageTemplate(packageVersion), "utf8")
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }

  return { name, directory, entry, worker, manifest, celldManifest, packageManifest }
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
    summaryField("", shownPath(actor.directory, actor.worker), colors),
    summaryField("", shownPath(actor.directory, actor.manifest), colors),
    summaryField("", shownPath(actor.directory, actor.celldManifest), colors),
    summaryField("", shownPath(actor.directory, actor.packageManifest), colors),
    summaryField("credential", credential, colors),
    ...(answers.region === undefined ? [] : [summaryField("region", answers.region, colors)]),
    "",
    styled("→ next", "1;36", colors),
    `  cd ${shellWord(directory)}`,
    "  tdg dev",
    "",
    styled("→ call from another terminal", "1;36", colors),
    `  ${callCommand()}`,
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
