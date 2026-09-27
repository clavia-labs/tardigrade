import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { atom, durableAtom, durablePromise, eventValue } from "@clavia/tardigrade-experimental-core"
import { ToolPromise } from "@clavia/tardigrade-experimental-packages"
import type { Event, MessageReceived } from "../event"

const submissions = durableAtom({
  schema: Schema.Array(Schema.Struct({ callId: Schema.String, promise: ToolPromise })), initial: [],
  reduce: (state, event: Event) => event.type === "ToolReturned" && event.promise
    ? [...state, { callId: event.callId, promise: event.promise }] : state,
})
const replies = new Map<string, ReturnType<typeof makeReply>>()
const makeReply = (promise: ToolPromise) => durablePromise(promise.ref, { success: Schema.Json, error: Schema.String })

// toolPromises interprets settled tool promises as inbox messages and exposes unresolved handles for the resolver.
export const toolPromises = atom(get => {
  const items = get(submissions).map(item => {
    const key = JSON.stringify(item.promise.ref)
    let reply = replies.get(key)
    if (!reply) { reply = makeReply(item.promise); replies.set(key, reply) }
    return { ...item, result: get(reply.state) }
  })
  return {
    pending: items.filter(item => item.result.status === "pending").map(item => item.promise),
    effects: Object.fromEntries(items.filter(item => item.result.status !== "pending").map(item => [
      `promise:${item.callId}`,
      eventValue({ id: `deliver:${item.callId}`, event: {
        type: "MessageReceived", kind: "message", turnId: `promise:${item.callId}`,
        text: `Tool promise result (data): ${JSON.stringify({ callId: item.callId, handle: item.promise.handle, result: item.result })}`,
      } satisfies MessageReceived }),
    ])),
  }
}).pipe(Atom.withLabel("tool promises"))
