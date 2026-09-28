import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { ThreadCoordinate } from "@clavia/tardigrade-experimental-host"
import { createBunHost, observeBunSupervisor, bunThreadActivity } from "@clavia/tardigrade-experimental-platform/bun"
import { actor } from "./actor"
import { services } from "./services"

export const DEFAULT_THREAD_DIRECTORY = ".tardigrade/threads"
export const DEFAULT_INSTANCE = "cli"
export interface ThreadOptions { readonly directory: string; readonly instance: string; readonly maxChildDepth?: number }
export type ChatHost = Awaited<ReturnType<typeof openHost>>
export type ChatThread = Awaited<ReturnType<ChatHost["allocateRootThread"]>>
const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: RuntimeError.from })

const openHost = (options: ThreadOptions) => createBunHost({ actor, storage: options.directory, services: (_coordinate, runtime) => services(options)(runtime) })
export const hostScope = (options: ThreadOptions) => Effect.acquireRelease(attempt(() => openHost(options)), host => Effect.promise(() => host.close()))

export async function listThreads(options: ThreadOptions) {
  const store = observeBunSupervisor({ storage: options.directory, actor: actor.actorName, instance: options.instance })
  try {
    await store.refresh()
    return store.threads.get().map(thread => ({ ...thread, lastActivity: bunThreadActivity(options.directory, thread.coordinate) }))
      .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.name.localeCompare(b.name))
  } finally { await store.close() }
}
export type ThreadListing = Awaited<ReturnType<typeof listThreads>>[number]

export async function findThread(options: ThreadOptions, name: string) {
  const found = (await listThreads(options)).find(thread => thread.coordinate.thread === name || (thread.parent === null && thread.name === name))
  if (!found) throw new RuntimeError(`Unknown thread: ${name}. Use /threads to list threads.`)
  return found.coordinate
}

const activePath = (options: ThreadOptions) => join(options.directory, `active-${Buffer.from(JSON.stringify([actor.actorName, options.instance])).toString("base64url")}.json`)

export async function activeThread(options: ThreadOptions): Promise<ThreadCoordinate | undefined> {
  const text = await readFile(activePath(options), "utf8").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return undefined
  const coordinate = Schema.decodeUnknownSync(ThreadCoordinate)(JSON.parse(text))
  if (coordinate.actor !== actor.actorName || coordinate.instance !== options.instance) throw new RuntimeError("Active thread belongs to another actor instance")
  return coordinate
}

export async function activateThread(options: ThreadOptions, coordinate: ThreadCoordinate) {
  await mkdir(options.directory, { recursive: true })
  const temporary = `${activePath(options)}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(coordinate))
  await rename(temporary, activePath(options))
}
