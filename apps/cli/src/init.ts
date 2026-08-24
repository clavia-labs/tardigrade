import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { DEFAULT_PROJECT_CONFIG_PATH } from "@clavia/tardigrade-server/config"

import { actorTemplate, type ActorTemplateModel } from "./template"
import { callCommandFor, shellWord } from "./workflow"

export const DEFAULT_ACTOR_ENTRY = "actor.ts"

export interface InitActorOptions {
  readonly model: ActorTemplateModel
  readonly cwd?: string
  readonly directory?: string
  readonly force?: boolean
}

export interface InitializedActor {
  readonly name: string
  readonly directory: string
  readonly entry: string
  readonly manifest: string
}

export const defaultInitDirectory = (name: string): string => name

const manifestTemplate = (name: string): string => `${JSON.stringify({
  $schema: "./node_modules/wrangler/config-schema.json",
  name,
  vars: {}
}, undefined, 2)}\n`

const existsError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"

export const initActor = async (name: string, options: InitActorOptions): Promise<InitializedActor> => {
  const cwd = options.cwd ?? process.cwd()
  const directory = resolve(cwd, options.directory ?? defaultInitDirectory(name))
  const entry = resolve(directory, DEFAULT_ACTOR_ENTRY)
  const manifest = resolve(directory, DEFAULT_PROJECT_CONFIG_PATH)
  const source = await actorTemplate({ name, model: options.model })

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
    await writeFile(manifest, manifestTemplate(name), { encoding: "utf8", flag: "wx" })
  } catch (error) {
    if (!existsError(error)) throw error
  }

  return { name, directory, entry, manifest }
}

const shownPath = (cwd: string, path: string): string => {
  const shown = relative(cwd, path)
  return shown.length === 0 ? "." : shown
}

export const initSummary = (actor: InitializedActor, cwd: string = process.cwd()): string => {
  const directory = shownPath(cwd, actor.directory)
  const entry = shownPath(actor.directory, actor.entry)
  return [
    `created ${shownPath(cwd, actor.entry)}`,
    `created ${shownPath(cwd, actor.manifest)}`,
    "",
    "next",
    `  cd ${shellWord(directory)}`,
    `  tdg push ${shellWord(entry)} --target local`,
    "  tdg dev",
    "",
    "then, in another terminal",
    `  ${callCommandFor(actor.name)}`
  ].join("\n")
}
