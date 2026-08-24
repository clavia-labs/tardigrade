import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  actorMethodsOf,
  type ActorMethods,
  type ActorArtifactManifest,
  type ActorDefinition
} from "tardie"

import { shellWord } from "./workflow"

export const DEFAULT_BUILD_DIRECTORY = ".tardigrade/build"
export const ACTOR_MODULE_FILE = "actor.mjs"
export const ACTOR_MANIFEST_FILE = "manifest.json"
export const TARDIE_ENTRY = fileURLToPath(import.meta.resolve("tardie"))

export interface BuildActorOptions {
  readonly out?: string
  readonly cwd?: string
}

export interface BuiltActor {
  readonly directory: string
  readonly manifest: ActorArtifactManifest
}

const definitionOf = async (modulePath: string): Promise<ActorDefinition<unknown>> => {
  const loaded: unknown = await import(`${pathToFileURL(modulePath).href}?build=${crypto.randomUUID()}`)
  const definition = (loaded as { readonly default?: unknown }).default
  if (typeof definition !== "object" || definition === null) {
    throw new Error("actor entry must default export defineActor({ name, methods, actor })")
  }
  const candidate = definition as Partial<ActorDefinition<unknown>>
  if (typeof candidate.name !== "string" || !ACTOR_NAME_PATTERN.test(candidate.name)) {
    throw new Error(`actor entry name must match ${String(ACTOR_NAME_PATTERN)}`)
  }
  if (
    typeof candidate.actor !== "object" ||
    candidate.actor === null ||
    !Array.isArray(candidate.actor.reactors) ||
    typeof candidate.actor.keyOf !== "function"
  ) {
    throw new Error("actor entry must contain an Actor in its actor field")
  }
  if (typeof candidate.methods !== "object" || candidate.methods === null || Array.isArray(candidate.methods)) {
    throw new Error("actor entry must declare its methods")
  }
  actorMethodsOf(candidate.methods as ActorMethods)
  return candidate as ActorDefinition<unknown>
}

export const tardiePlugin = (entry: string = TARDIE_ENTRY): Bun.BunPlugin => ({
  name: "tardie",
  setup(builder) {
    builder.onResolve({ filter: /^tardie$/ }, () => ({ path: entry }))
  }
})

export const buildActor = async (entry: string, options: BuildActorOptions = {}): Promise<BuiltActor> => {
  const cwd = resolve(options.cwd ?? process.cwd())
  const source = resolve(cwd, entry)
  const out = resolve(cwd, options.out ?? DEFAULT_BUILD_DIRECTORY)
  await mkdir(dirname(out), { recursive: true })
  const temporary = await mkdtemp(join(dirname(out), ".tdg-build-"))
  try {
    const result = await Bun.build({
      entrypoints: [source],
      outdir: temporary,
      naming: ACTOR_MODULE_FILE,
      target: "bun",
      format: "esm",
      minify: false,
      sourcemap: "none",
      plugins: [tardiePlugin()]
    })
    if (!result.success) {
      const detail = result.logs.map((log) => log.message).join("\n")
      throw new Error(detail.length > 0 ? detail : `could not build ${entry}`)
    }
    const modulePath = join(temporary, ACTOR_MODULE_FILE)
    const definition = await definitionOf(modulePath)
    const code = await readFile(modulePath)
    const manifest: ActorArtifactManifest = {
      schema: ACTOR_ARTIFACT_VERSION,
      name: definition.name,
      module: ACTOR_MODULE_FILE,
      digest: `sha256:${createHash("sha256").update(code).digest("hex")}`
    }
    await writeFile(join(temporary, ACTOR_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await mkdir(out, { recursive: true })
    const destination = join(out, definition.name)
    const previous = `${destination}.previous`
    await rm(previous, { recursive: true, force: true })
    try {
      await rename(destination, previous)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      await rename(temporary, destination)
    } catch (error) {
      try {
        await rename(previous, destination)
      } catch {}
      throw error
    }
    await rm(previous, { recursive: true, force: true })
    return { directory: destination, manifest }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export const buildSummary = (built: BuiltActor, entry: string): string =>
  [
    `built ${built.manifest.name}`,
    `at    ${built.directory}`,
    `hash  ${built.manifest.digest}`,
    "",
    "next",
    `  tdg push ${shellWord(entry)} --target local`
  ].join("\n")
