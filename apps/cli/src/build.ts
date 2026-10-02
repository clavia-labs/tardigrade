import { Effect } from "effect"
import { targetCoordinate } from "@clavia/tardigrade-deprecated-core/actor"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  actorMethodsOf,
  validateActor,
  type ActorContract,
  type ActorMethods,
  type ActorArtifactManifest,
  type Actor
} from "tardie/deprecated"

export const DEFAULT_BUILD_DIRECTORY = ".tardigrade/build"
export const ACTOR_MODULE_FILE = "actor.mjs"
export const ACTOR_MANIFEST_FILE = "manifest.json"
export const TARDIE_ENTRY = fileURLToPath(import.meta.resolve("tardie/deprecated"))

export interface BuildActorOptions {
  readonly out?: string
  readonly cwd?: string
}

export interface BuiltActor {
  readonly directory: string
  readonly manifest: ActorArtifactManifest & { readonly runtime?: "atoms" }
}

export interface LintedActorMethod {
  readonly name: string
  readonly handling: ReadonlyArray<"local" | "external">
}

export interface LintedActorCall {
  readonly method: string
  readonly target: string
}

export interface LintedActor {
  readonly name: string
  readonly methods: ReadonlyArray<LintedActorMethod> | null
  readonly calls: ReadonlyArray<LintedActorCall>
}

const actorModuleOf = async (modulePath: string): Promise<Record<string, unknown>> => {
  const loaded: unknown = await import(`${pathToFileURL(modulePath).href}?build=${crypto.randomUUID()}`)
  if (typeof loaded !== "object" || loaded === null) throw new Error("actor entry must export a module")
  return loaded as Record<string, unknown>
}

const definitionFrom = (loaded: Record<string, unknown>): Actor<unknown> => {
  const definition = loaded.default
  if (typeof definition !== "object" || definition === null) {
    throw new Error("actor entry must default export actor({ name, methods, components })")
  }
  const candidate = definition as Partial<Actor<unknown>>
  if (typeof candidate.name !== "string" || !ACTOR_NAME_PATTERN.test(candidate.name)) {
    throw new Error(`actor entry name must match ${String(ACTOR_NAME_PATTERN)}`)
  }
  if (
    !Array.isArray(candidate.components)
  ) {
    throw new Error("actor entry must contain reconciled components")
  }
  if (typeof candidate.methods !== "object" || candidate.methods === null || Array.isArray(candidate.methods)) {
    throw new Error("actor entry must declare its methods")
  }
  actorMethodsOf(candidate.methods as ActorMethods)
  return candidate as Actor<unknown>
}

interface AtomActorDefinition {
  readonly actorName: string
  readonly setup: Effect.Effect<unknown, unknown, unknown>
  readonly graph: () => Effect.Effect<unknown, unknown, unknown>
}

const atomDefinitionFrom = (loaded: Record<string, unknown>) => {
  const candidate = loaded.default
  if (typeof candidate !== "object" || candidate === null || !("actorName" in candidate)) return undefined
  if (typeof candidate.actorName !== "string" || !ACTOR_NAME_PATTERN.test(candidate.actorName) || !("setup" in candidate) || !Effect.isEffect(candidate.setup) || !("graph" in candidate) || typeof candidate.graph !== "function") throw new Error("invalid atom actor definition")
  return { name: candidate.actorName, definition: candidate as AtomActorDefinition }
}

// loadBuiltActor returns a validated component or atom definition from a built artifact.
export const loadBuiltActor = async (built: BuiltActor): Promise<Actor<unknown> | AtomActorDefinition> => {
  const loaded = await actorModuleOf(join(built.directory, ACTOR_MODULE_FILE))
  return atomDefinitionFrom(loaded)?.definition ?? definitionFrom(loaded)
}

export const tardiePlugin = (entry: string = TARDIE_ENTRY): Bun.BunPlugin => ({
  name: "tardie",
  setup(builder) {
    builder.onResolve({ filter: /^tardie\/deprecated(?:\/.*)?$/ }, ({ path }) => ({ path: path === "tardie/deprecated" ? entry : Bun.resolveSync(path, dirname(entry)) }))
  }
})

const bundleActor = async (source: string, outdir: string): Promise<string> => {
  const modulePath = join(outdir, ACTOR_MODULE_FILE)
  const script = `
    const result = await Bun.build({
      entrypoints: [${JSON.stringify(source)}], outdir: ${JSON.stringify(outdir)},
      naming: ${JSON.stringify(ACTOR_MODULE_FILE)}, target: "bun", format: "esm", minify: false, sourcemap: "none",
      plugins: [{ name: "tardie", setup(build) {
        build.onResolve({ filter: /^tardie(?:\\/.*)?$/ }, ({ path }) => ({
          path: path === "tardie/deprecated" ? ${JSON.stringify(TARDIE_ENTRY)} : Bun.resolveSync(path, ${JSON.stringify(dirname(TARDIE_ENTRY))})
        }));
      } }],
    });
    if (!result.success) throw new AggregateError(result.logs, "Could not build actor");
  `
  const compiled = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [code, errors] = await Promise.all([compiled.exited, new Response(compiled.stderr).text(), new Response(compiled.stdout).text()])
  if (code !== 0) throw new Error(errors.trim() || `Could not build ${source}`)
  return modulePath
}

const contractOf = (definition: Actor<unknown>): ActorContract => {
  if (definition.contract === undefined) {
    throw new Error("actor entry has no component method contract; construct it with actor()")
  }
  return validateActor(definition as Actor<unknown> & { readonly contract: ActorContract }).contract
}

// lintActor validates the method seams of one actor source without writing an artifact.
export const lintActor = async (entry: string, options: Pick<BuildActorOptions, "cwd"> = {}): Promise<LintedActor> => {
  const cwd = resolve(options.cwd ?? process.cwd())
  const source = resolve(cwd, entry)
  const temporary = await mkdtemp(join(tmpdir(), "tdg-lint-"))
  try {
    const loaded = await actorModuleOf(await bundleActor(source, temporary))
    const modern = atomDefinitionFrom(loaded)
    if (modern) {
      return { name: modern.name, methods: null, calls: [] }
    }
    const definition = definitionFrom(loaded)
    const contract = contractOf(definition)
    return {
      name: definition.name,
      ...(modern ? { runtime: "atoms" as const } : {}),
      methods: contract.methods.map((method) => ({ name: method.name, handling: method.handling })),
      calls: contract.calls.map((call) => ({
        method: call.methodName ?? "<undeclared>",
        target: "kind" in call.target
          ? "caller"
          : `${targetCoordinate(call.target).actor}:${targetCoordinate(call.target).thread}`
      }))
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export const lintSummary = (linted: LintedActor): string => [
  `linted  ${linted.name}`,
  `methods ${linted.methods === null ? "validated during actor setup" : linted.methods.length}`,
  `calls   ${linted.calls.length}`
].join("\n")

export const buildActor = async (entry: string, options: BuildActorOptions = {}): Promise<BuiltActor> => {
  const cwd = resolve(options.cwd ?? process.cwd())
  const source = resolve(cwd, entry)
  const out = resolve(cwd, options.out ?? DEFAULT_BUILD_DIRECTORY)
  await mkdir(dirname(out), { recursive: true })
  const temporary = await mkdtemp(join(dirname(out), ".tdg-build-"))
  try {
    const modulePath = await bundleActor(source, temporary)
    const loaded = await actorModuleOf(modulePath)
    const modern = atomDefinitionFrom(loaded)
    const definition = modern ?? definitionFrom(loaded)
    const code = await readFile(modulePath)
    const manifest: BuiltActor["manifest"] = {
      schema: ACTOR_ARTIFACT_VERSION,
      name: definition.name,
      ...(modern ? { runtime: "atoms" as const } : {}),
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

export const buildSummary = (built: BuiltActor): string =>
  [
    `built ${built.manifest.name}`,
    `at    ${built.directory}`,
    `hash  ${built.manifest.digest}`
  ].join("\n")
