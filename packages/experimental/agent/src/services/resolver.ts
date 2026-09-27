import { Effect, Layer, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { atom, durableAtom, type ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { Resolver, Resolution, ResolutionRequest, resolutionKey } from "@clavia/tardigrade-experimental-host"
import { alarmState, alarmRequest } from "@clavia/tardigrade-experimental-packages"
import { toolPromises } from "../atoms/promises"
import { ModelSubmitted, type Event } from "../event"

const remoteModels = durableAtom({
  schema: Schema.Array(ModelSubmitted), initial: [],
  reduce: (state, event: Event) => {
    if (event.type === "ModelSubmitted" && event.handle.executor !== "local") return [...state, event]
    if (event.type === "PromiseSettled") return state.filter(item => resolutionKey(item) !== resolutionKey({ ref: event.ref, handle: item.handle }))
    if (event.type === "TurnSettled") return []
    return state
  },
})
const requests = atom(get => ({
  pending: [
    ...get(toolPromises).pending.filter(item => item.handle.executor !== "local").map(({ ref, handle }) => ({ ref, handle })),
    ...get(remoteModels).map(({ ref, handle }) => ({ ref, handle })),
    ...get(alarmState).filter(item => item.status === "pending").map(alarmRequest),
  ],
  cancelled: get(alarmState).filter(item => item.status === "cancelled").map(alarmRequest),
})).pipe(Atom.withLabel("promise registrations"))

// resolverServices reconciles durable promise intentions with the host resolver after replay and journal commits.
export function resolverServices(host: ActorRuntime<Event>) {
  return Layer.effect(Resolver, Effect.gen(function* () {
    const resolver = yield* Resolver
    const watching = new Map<string, ResolutionRequest>()
    const cancelled = new Set<string>()
    const reconcile = Effect.gen(function* () {
      const state = host.get(requests)
      const active = new Set(state.pending.map(resolutionKey))
      for (const key of watching.keys()) if (!active.has(key)) watching.delete(key)
      for (const request of state.cancelled) {
        const key = resolutionKey(request)
        if (cancelled.has(key)) continue
        yield* resolver.cancel(request)
        cancelled.add(key)
      }
      for (const request of state.pending) {
        const key = resolutionKey(request)
        if (watching.has(key)) continue
        yield* resolver.watch(request)
        watching.set(key, request)
      }
    })
    yield* host.onReady(reconcile)
    yield* host.onCommit(reconcile)
    return resolver
  }))
}

// receiveResolution acknowledges repeated deliveries after the matching model, tool, or alarm promise has settled.
export function receiveResolution(host: ActorRuntime<Event>, settlement: Resolution) {
  return Schema.decodeEffect(Resolution)(settlement).pipe(Effect.flatMap(event => host.send([event],
    get => get(requests).pending.some(item => item.ref.atom === event.ref.atom && item.ref.seq === event.ref.seq && item.ref.tag === event.ref.tag),
  )))
}
