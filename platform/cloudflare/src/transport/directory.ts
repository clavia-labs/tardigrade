import { cloudflareRetryPolicy, makeRetryingRpc } from "../retry"
import { Effect } from "effect"
import { resolveThreadId } from "@clavia/tardigrade-host/thread-compat"
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
    const rpc = makeRetryingRpc({ retry: cloudflareRetryPolicy(env.TARDIGRADE_CONFIG) })
    return Effect.runPromise(rpc.call(env.ACTORS, actorObjectNameOf(name, instance), create ? "init" : "exists", async stub => {
      if (!create && !(await stub.exists(name, instance))) return undefined
      if (create) await stub.init(name, instance)
      return stub
    }, true))
  }

  const resolvePublicThread = (env: Env, name: string, instance: string, id: string): Promise<string> =>
    Effect.runPromise(resolveThreadId(id, (thread) => makeRetryingRpc({ retry: cloudflareRetryPolicy(env.TARDIGRADE_CONFIG) }).call(
      env.THREADS, threadObjectNameOf(name, instance, thread), "exists", stub => stub.exists(name, instance, thread), true
    ).pipe(Effect.orDie)))

  const threadStub = async (
    env: Env,
    name: string,
    instance: string,
    thread: string
  ): Promise<{ readonly stub: DurableObjectStub<ThreadDO>; readonly thread: string } | undefined> => {
    if (!deployed(name)) return undefined
    const targetThread = await resolvePublicThread(env, name, instance, thread)
    const rpc = makeRetryingRpc({ retry: cloudflareRetryPolicy(env.TARDIGRADE_CONFIG) })
    return Effect.runPromise(rpc.call(env.THREADS, threadObjectNameOf(name, instance, targetThread), "exists", async stub =>
      await stub.exists(name, instance, targetThread) ? { stub, thread: targetThread } : undefined, true))
  }
  return { actorStub, threadStub }
}

export type CloudflareDirectory = ReturnType<typeof cloudflareDirectory>
