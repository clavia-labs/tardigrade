import { Effect } from "effect"
import { resolveThreadId } from "@clavia/tardigrade-server/thread-compat"
import type { ActorDO } from "../actor"
import type { ThreadDO } from "../thread"
import type { Env } from "../env"

export const actorObjectNameOf = (actor: string, instance: string): string => JSON.stringify([actor, instance])
export const threadObjectNameOf = (actor: string, instance: string, thread: string): string => JSON.stringify([actor, instance, thread])

// cloudflareDirectory resolves deployed actor coordinates to Durable Object stubs.
export const cloudflareDirectory = (deployed: (name: string) => boolean) => {
  const actorStub = async (
    env: Env,
    name: string,
    instance: string,
    create: boolean
  ): Promise<DurableObjectStub<ActorDO> | undefined> => {
    if (!deployed(name)) return undefined
    const stub = env.ACTORS.getByName(actorObjectNameOf(name, instance))
    if (!create && !(await stub.exists(name, instance))) return undefined
    if (create) await stub.init(name, instance)
    return stub
  }

  const resolvePublicThread = (env: Env, name: string, instance: string, id: string): Promise<string> =>
    Effect.runPromise(resolveThreadId(id, (thread) => Effect.promise(() =>
      env.THREADS.getByName(threadObjectNameOf(name, instance, thread)).exists(name, instance, thread)
    )))

  const threadStub = async (
    env: Env,
    name: string,
    instance: string,
    thread: string
  ): Promise<{ readonly stub: DurableObjectStub<ThreadDO>; readonly thread: string } | undefined> => {
    if (!deployed(name)) return undefined
    const targetThread = await resolvePublicThread(env, name, instance, thread)
    const stub = env.THREADS.getByName(threadObjectNameOf(name, instance, targetThread))
    if (!(await stub.exists(name, instance, targetThread))) return undefined
    return { stub, thread: targetThread }
  }
  return { actorStub, threadStub }
}

export type CloudflareDirectory = ReturnType<typeof cloudflareDirectory>
