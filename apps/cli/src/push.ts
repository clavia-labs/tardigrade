import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { ActorArtifactManifest } from "tardie"

import { ACTOR_MANIFEST_FILE, ACTOR_MODULE_FILE, buildActor, type BuildActorOptions, type BuiltActor } from "./build"

export const DEFAULT_ACTOR_DIRECTORY = ".tardigrade/actors"
export const PUSH_PATH = "/v1/actors"
export const PUSH_TARGETS = ["local", "hosted"] as const

export type PushTarget = typeof PUSH_TARGETS[number]

export interface PushActorOptions extends BuildActorOptions {
  readonly target: PushTarget
  readonly actors?: string
  readonly baseUrl?: string
  readonly token?: string
  readonly fetch?: typeof globalThis.fetch
}

export interface PushedActor extends BuiltActor {
  readonly target: PushTarget
  readonly location: string
}

interface ActorPayload {
  readonly manifest: ActorArtifactManifest
  readonly module: string
}

const payloadOf = async (built: BuiltActor): Promise<ActorPayload> => {
  const module = await readFile(join(built.directory, ACTOR_MODULE_FILE), "utf8")
  const digest = `sha256:${createHash("sha256").update(module).digest("hex")}`
  if (digest !== built.manifest.digest) throw new Error(`actor artifact digest mismatch: expected ${built.manifest.digest}, got ${digest}`)
  return { manifest: built.manifest, module }
}

const pushLocal = async (built: BuiltActor, options: PushActorOptions): Promise<PushedActor> => {
  const cwd = resolve(options.cwd ?? process.cwd())
  const actors = resolve(cwd, options.actors ?? DEFAULT_ACTOR_DIRECTORY)
  await mkdir(actors, { recursive: true })
  const destination = join(actors, built.manifest.name)
  const temporary = `${destination}.incoming`
  const previous = `${destination}.previous`
  await rm(temporary, { recursive: true, force: true })
  await rm(previous, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true })
  const payload = await payloadOf(built)
  await Bun.write(join(temporary, ACTOR_MODULE_FILE), payload.module)
  await Bun.write(join(temporary, ACTOR_MANIFEST_FILE), `${JSON.stringify(payload.manifest, null, 2)}\n`)
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
  return { ...built, target: "local", location: destination }
}

const responseMessage = async (response: Response): Promise<string> => {
  const body = await response.text()
  if (body.length === 0) return `${response.status} ${response.statusText}`.trim()
  try {
    const parsed = JSON.parse(body) as { readonly detail?: unknown; readonly title?: unknown }
    if (typeof parsed.detail === "string") return parsed.detail
    if (typeof parsed.title === "string") return parsed.title
  } catch {}
  return body
}

const pushHosted = async (built: BuiltActor, options: PushActorOptions): Promise<PushedActor> => {
  if (options.baseUrl === undefined) throw new Error("hosted push requires --url or TARDIGRADE_URL")
  const baseUrl = options.baseUrl.replace(/\/+$/u, "")
  const response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${PUSH_PATH}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` })
    },
    body: JSON.stringify(await payloadOf(built))
  })
  if (!response.ok) throw new Error(`hosted push failed (${response.status}): ${await responseMessage(response)}`)
  return { ...built, target: "hosted", location: `${baseUrl}/actors/${built.manifest.name}` }
}

export const pushActor = async (entry: string, options: PushActorOptions): Promise<PushedActor> => {
  const built = await buildActor(entry, options)
  return options.target === "local" ? pushLocal(built, options) : pushHosted(built, options)
}

export const pushSummary = (pushed: PushedActor): string =>
  [
    `pushed ${pushed.manifest.name}`,
    `to     ${pushed.target}`,
    `at     ${pushed.location}`,
    `hash   ${pushed.manifest.digest}`
  ].join("\n")
