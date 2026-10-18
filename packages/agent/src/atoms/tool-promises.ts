import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { effectAtom, atom, keyValue, durableAtom, durablePromise, eventValue, EffectCancelled, effectKey } from "@clavia/tardigrade-core"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { ToolReturned, TurnRequested } from "../contracts/events"
import { StoredToolResult } from "@clavia/tardigrade-model/object/content"

const Submission = Schema.Struct({ callId: Schema.String, promise: ToolPromise })
export const promiseRecords = durableAtom({
  name: "agent.promises.submissions", input: Schema.Union([ToolReturned, TurnRequested, EffectCancelled]),
  schema: keyValue(Submission), initial: {},
  migrate: value => Array.isArray(value) ? Object.fromEntries(Schema.decodeSync(Schema.Array(Submission))(value).map(entry => [JSON.stringify(entry.callId), entry])) : value,
  reduce: (state, event) => {
    if (event.type === "ToolReturned" && event.promise) return state.set([JSON.stringify(event.callId)], { callId: event.callId, promise: event.promise })
    if (event.type === "TurnRequested" && event.turnId.startsWith("promise:")) return state.remove([JSON.stringify(event.turnId.slice("promise:".length))])
    if (event.type !== "EffectCancelled") return state
    return state.batch(edit => { for (const item of Object.values(state.read([]))) if (effectKey(item.promise.ref) === effectKey(event.ref)) edit.remove([JSON.stringify(item.callId)]) })
  },
})
export const toolPromiseSubmissions = atom(get => Object.values(get(promiseRecords).read([])))
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
        ...(item.result.status === "fulfilled" && Schema.is(StoredToolResult)(item.result.value) ? {
          content: [{ type: "text" as const, text: `Tool promise result for call ${item.callId}.` }, ...item.result.value.content],
        } : {}),
      } satisfies TurnRequested),
    ])),
  }
}).pipe(Atom.withLabel("tool promises"))
