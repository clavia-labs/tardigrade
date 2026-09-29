import { Effect, Layer, Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { atom, type ActorRuntime } from "@clavia/tardigrade-experimental-core"
import { Promises, PromiseSettled, ResolutionRequest, resolutionKey } from "@clavia/tardigrade-experimental-host"
import { toolPromises } from "../atoms/promises"
import { Event } from "../event"

const requests = atom(get => ({
  pending: get(toolPromises).view.pending.filter(item => item.handle.executor !== "local").map(({ ref, handle }) => ({ ref, handle })),
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

// receiveResolution delivers settlements for accepted effects; the runtime checks identity and repeated delivery.
export function receiveResolution(host: ActorRuntime<Event>, settlement: PromiseSettled) {
  return Schema.decodeEffect(PromiseSettled)(settlement).pipe(Effect.flatMap(event => host.send([event])))
}
