import { actorClient, type ActorClient as ConnectedActor, type CallOptions, type ClientThread } from "@clavia/tardigrade-core/actor/client"
import type { ActorDefinition } from "@clavia/tardigrade-core/actor/definition"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { actorHttpClient } from "./client"

export const DEFAULT_CALL_POLL_INTERVAL_MS = 100

export interface ConnectOptions<Methods extends ActorMethods> {
  readonly url: string
  readonly actor: Pick<ActorDefinition<Methods>, "name" | "methods">
  readonly token?: string
  readonly fetch?: typeof globalThis.fetch
  readonly pollIntervalMs?: number
}

export type { ConnectedActor, CallOptions, ClientThread }

// connect binds an actor's typed methods to its HTTP host.
export const connect = <const Methods extends ActorMethods>(options: ConnectOptions<Methods>): ConnectedActor<Methods> => {
  const base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`)
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("connect requires an HTTP URL")
  const interval = options.pollIntervalMs ?? DEFAULT_CALL_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(interval) || interval < 1) throw new Error("pollIntervalMs must be a positive safe integer")
  const { api, run, stateAt } = actorHttpClient({ baseUrl: base.href.replace(/\/$/, ""), token: options.token, fetch: options.fetch })
  return actorClient(options.actor, {
    allocate: async (allocation) => {
      const coordinate = allocation.kind === "root" ? allocation.coordinate : allocation.parent
      const name = allocation.key === undefined ? allocation.kind === "root" ? coordinate.thread : allocation.child : undefined
      const assigned = await run(api.threads.allocateRoot({
        params: { id: coordinate.instance }, query: { actor: coordinate.actor }, payload: {
          ...(name === undefined ? (allocation.key === undefined ? {} : { key: allocation.key }) : { name }),
          ...(allocation.kind === "child" ? { parent: allocation.parent.thread } : {})
        }
      }))
      if (assigned.actor !== coordinate.actor || assigned.instance !== coordinate.instance) throw new Error("host returned a different actor instance")
      return assigned
    },
    invoke: async (coordinate, method, input, call) => {
      const controller = new AbortController()
      const signal = call.signal === undefined ? controller.signal : AbortSignal.any([call.signal, controller.signal])
      let timer = setTimeout(() => controller.abort(new Error("actor call deadline exceeded")), call.timeoutMs ?? options.actor.methods[method]!.timeoutMs)
      let deadlineSet = false
      try {
        const [accepted, response] = await run(api.methods.invokeMethod({
          params: { id: coordinate.instance, thread: coordinate.thread, method },
          headers: { "idempotency-key": call.key }, query: { actor: coordinate.actor, ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }) },
          payload: input, responseMode: "decoded-and-response"
        }), signal)
        if (response.headers.location === undefined) throw new Error("host did not return a call Location")
        const location = new URL(response.headers.location, base)
        if (location.origin !== base.origin) throw new Error("call Location must belong to the host")
        if (accepted.reference.target.actor !== coordinate.actor || accepted.reference.target.instance !== coordinate.instance || accepted.reference.target.thread !== coordinate.thread || accepted.reference.invocation.method !== method || accepted.reference.invocation.id !== call.key) throw new Error("host returned a different invocation")
        for (;;) {
          const state = await stateAt(location.href, signal)
          if (state.status === "completed") return state.output
          if (state.status === "failed") throw new Error(state.error)
          if (state.status === "cancelled") throw new Error(state.reason ?? `actor call cancelled: ${state.cause}`)
          if (!deadlineSet) {
            deadlineSet = true
            clearTimeout(timer)
            timer = setTimeout(() => controller.abort(new Error("actor call deadline exceeded")), Math.max(0, accepted.deadlineAt - Date.now()))
          }
          await new Promise<void>((resolve, reject) => {
            signal.throwIfAborted()
            const abort = () => { clearTimeout(delay); reject(signal.reason) }
            const delay = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, interval)
            signal.addEventListener("abort", abort, { once: true })
          })
        }
      } finally { clearTimeout(timer) }
    }
  })
}
