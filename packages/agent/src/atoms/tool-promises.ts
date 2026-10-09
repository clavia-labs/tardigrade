import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { effectAtom, durableAtom, durablePromise, eventValue, EffectCancelled, effectKey } from "@clavia/tardigrade-core"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { ToolReturned, TurnRequested } from "../contracts/events"

export const toolPromiseSubmissions = durableAtom({
  name: "agent.promises.submissions",
  input: Schema.Union([ToolReturned, TurnRequested, EffectCancelled]),
  schema: Schema.Array(Schema.Struct({ callId: Schema.String, promise: ToolPromise })), initial: [],
  reduce: (state, event) => event.type === "ToolReturned" && event.promise
    ? [...state, { callId: event.callId, promise: event.promise }]
    : event.type === "EffectCancelled" ? state.filter(item => effectKey(item.promise.ref) !== effectKey(event.ref))
    : event.type === "TurnRequested" ? state.filter(item => event.turnId !== `promise:${item.callId}`) : state,
})
const replies = new Map<string, ReturnType<typeof makeReply>>()
const makeReply = (promise: ToolPromise) => durablePromise(promise.ref, { success: Schema.Json, error: Schema.String })

// toolPromises interprets settled tool promises as turn requests and exposes unresolved handles for the resolver.
export const toolPromises = effectAtom(get => {
  const items = get(toolPromiseSubmissions).map(item => {
    const key = JSON.stringify(item.promise.ref)
    let reply = replies.get(key)
    if (!reply) { reply = makeReply(item.promise); replies.set(key, reply) }
    return { ...item, result: get(reply.state) }
  })
  return {
    view: { pending: items.filter(item => item.result.status === "pending").map(item => item.promise) },
    acts: {}, events: Object.fromEntries(items.filter(item => item.result.status !== "pending").map(item => [
      `promise:${encodeURIComponent(item.callId)}`,
      eventValue({
        type: "TurnRequested", source: item.promise.handle.executor === "actor" ? "agent" : "tool", promiseRef: item.promise.ref, turnId: `promise:${item.callId}`,
        text: `Tool promise result (data): ${JSON.stringify({ callId: item.callId, handle: item.promise.handle, result: item.result })}`,
      } satisfies TurnRequested),
    ])),
  }
}).pipe(Atom.withLabel("tool promises"))
