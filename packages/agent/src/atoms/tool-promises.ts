import { Schema } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { effectAtom, atom, durableAtom, durablePromise, eventValue, EffectCancelled, effectKey } from "@clavia/tardigrade-core"
import { ToolPromise } from "@clavia/tardigrade-libraries/types"
import { ToolReturned, TurnRequested } from "../contracts/events"
import { StoredToolResult } from "@clavia/tardigrade-model/object/content"

const Submission = Schema.Struct({ callId: Schema.String, promise: ToolPromise })
export const promiseRecords = durableAtom({
  name: "agent.promises.submissions", input: Schema.Union([ToolReturned, TurnRequested, EffectCancelled]),
  schema: Schema.Array(Submission), initial: [],
  migrate: stored => Array.isArray(stored) ? stored : Object.values(Schema.decodeUnknownSync(Schema.Record(Schema.String, Submission))(stored)),
  reduce: (state, event) => {
    if (event.type === "ToolReturned" && event.promise) {
      const item = { callId: event.callId, promise: event.promise }
      return state.some(value => value.callId === event.callId) ? state.map(value => value.callId === event.callId ? item : value) : [...state, item]
    }
    const next = event.type === "TurnRequested" && event.turnId.startsWith("promise:") ? state.filter(value => value.callId !== event.turnId.slice("promise:".length))
      : event.type === "EffectCancelled" ? state.filter(value => effectKey(value.promise.ref) !== effectKey(event.ref)) : state
    return next.length === state.length ? state : next
  },
})
export const toolPromiseSubmissions = atom(get => get(promiseRecords))

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
