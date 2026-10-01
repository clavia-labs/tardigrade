import { actorContext } from "@clavia/tardigrade-experimental-agent/context"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { ThreadCoordinate } from "@clavia/tardigrade-experimental-host"
import { createBunHost, observeBunSupervisor, bunThreadActivity } from "@clavia/tardigrade-experimental-platform/bun"
import { actor } from "./actor"
import { services } from "./services"
import type { Permissions } from "./permissions"

export const DEFAULT_THREAD_DIRECTORY = ".tardigrade/threads"
export const DEFAULT_INSTANCE = "cli"
export interface ThreadOptions { readonly directory: string; readonly instance: string; readonly permissions?: Permissions }
export type ChatHost = Effect.Success<ReturnType<typeof openHost>>
export type ChatThread = Effect.Success<ReturnType<ChatHost["allocateRootThread"]>>

const openHost = (options: ThreadOptions) => createBunHost({ actor, actorContext, storage: options.directory, services: (coordinate, runtime) => services({ ...options, label: `Thread ${coordinate.thread}` })(runtime) })
export const hostScope = (options: ThreadOptions) => Effect.acquireRelease(openHost(options).pipe(Effect.mapError(RuntimeError.from)), host => host.close.pipe(Effect.orDie))

export const listThreads = (options: ThreadOptions) => Effect.acquireUseRelease(
  Effect.sync(() => observeBunSupervisor({ storage: options.directory, actor: actor.actorName, instance: options.instance })),
  store => store.refresh.pipe(Effect.map(() => store.threads.get().map(thread => ({ ...thread, lastActivity: bunThreadActivity(options.directory, thread.coordinate) }))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.name.localeCompare(b.name)))),
  store => store.close,
).pipe(Effect.mapError(RuntimeError.from))
export type ThreadListing = Effect.Success<ReturnType<typeof listThreads>>[number]

export const findThread = (options: ThreadOptions, name: string) => Effect.gen(function* () {
  const found = (yield* listThreads(options)).find(thread => thread.coordinate.thread === name || (thread.parent === null && thread.name === name))
  if (!found) return yield* Effect.fail(new RuntimeError(`Unknown thread: ${name}. Use /threads to list threads.`))
  return found.coordinate
})

const activePath = (options: ThreadOptions) => join(options.directory, `active-${Buffer.from(JSON.stringify([actor.actorName, options.instance])).toString("base64url")}.json`)

export const activeThread = (options: ThreadOptions) => Effect.gen(function* () {
  const text = yield* Effect.tryPromise({
    try: () => readFile(activePath(options), "utf8").catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }),
    catch: RuntimeError.from,
  })
  if (text === undefined) return undefined
  const coordinate = yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: RuntimeError.from }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ThreadCoordinate)), Effect.mapError(RuntimeError.from),
  )
  if (coordinate.actor !== actor.actorName || coordinate.instance !== options.instance) return yield* Effect.fail(new RuntimeError("Active thread belongs to another actor instance"))
  return coordinate
})

export const activateThread = (options: ThreadOptions, coordinate: ThreadCoordinate) => Effect.gen(function* () {
  yield* Effect.tryPromise({ try: () => mkdir(options.directory, { recursive: true }), catch: RuntimeError.from })
  yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(options.directory, ".active-")), catch: RuntimeError.from }),
    directory => Effect.gen(function* () {
      const path = join(directory, "coordinate.json")
      yield* Effect.tryPromise({ try: () => writeFile(path, JSON.stringify(coordinate), { flag: "wx" }), catch: RuntimeError.from })
      yield* Effect.tryPromise({ try: () => rename(path, activePath(options)), catch: RuntimeError.from })
    }).pipe(Effect.uninterruptible),
    directory => Effect.tryPromise({ try: () => rm(directory, { recursive: true, force: true }), catch: RuntimeError.from }).pipe(Effect.orDie),
  )
})
