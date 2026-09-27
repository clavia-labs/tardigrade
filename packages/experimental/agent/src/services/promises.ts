import { Effect, Layer, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { atom, durableAtom, type ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { Promises, PromiseSettled, ResolutionRequest, resolutionKey } from "@clavia/tardigrade-experimental-host"
import { requestPromises } from "../atoms/requests"
import { toolPromises } from "../atoms/promises"
import { ModelPromiseReturned, Event } from "../event"

const remoteModels = durableAtom({
  input: Event,
  schema: Schema.Array(ModelPromiseReturned), initial: [],
  reduce: (state, event: Event) => {
    if (event.type === "ModelReturned" && "promise" in event && event.promise.handle.executor !== "local") return [...state, event]
    if (event.type === "PromiseSettled") return state.filter(item => resolutionKey(item.promise) !== resolutionKey({ ref: event.ref, handle: item.promise.handle }))
    if (event.type === "TurnSettled") return []
    return state
  },
})
const requests = atom(get => ({
  pending: [
    ...get(requestPromises).filter(item => item.result.status === "pending" && item.handle.executor !== "local").map(({ ref, handle, mode }) => ({ ref, handle, ...(mode ? { mode } : {}) })),
    ...get(toolPromises).view.pending.filter(item => item.handle.executor !== "local").map(({ ref, handle }) => ({ ref, handle })),
    ...get(remoteModels).map(({ promise: { ref, handle } }) => ({ ref, handle })),
  ],
})).pipe(Atom.withLabel("promise registrations"))

// promiseServices reconciles durable promise intentions with the host promise service after replay and journal commits.
export function promiseServices(host: ActorRuntime<Event>) {
  return Layer.effect(Promises, Effect.gen(function* () {
    const promises = yield* Promises
    const watching = new Map<string, ResolutionRequest>()
    const reconcile = Effect.gen(function* () {
      const state = host.get(requests)
      const active = new Set(state.pending.map(resolutionKey))
      for (const key of watching.keys()) if (!active.has(key)) watching.delete(key)
      for (const request of state.pending) {
        const key = resolutionKey(request)
        if (watching.has(key)) continue
        yield* promises.watch(request)
        watching.set(key, request)
      }
    })
    yield* host.onReady(reconcile)
    yield* host.onCommit(reconcile)
    return promises
  }))
}

// receiveResolution acknowledges repeated deliveries after the matching model, tool, or alarm promise has settled.
export function receiveResolution(host: ActorRuntime<Event>, settlement: PromiseSettled) {
  return Schema.decodeEffect(PromiseSettled)(settlement).pipe(Effect.flatMap(event => host.send([event],
    get => get(requests).pending.some(item => item.ref.atom === event.ref.atom && item.ref.seq === event.ref.seq && item.ref.tag === event.ref.tag),
  )))
}
