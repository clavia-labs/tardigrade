import { Schema } from "effect"
import { atom, durableAtom, durablePromise } from "@clavia/tardigrade-experimental-core"
import { PermissionSubmitted, BudgetSubmitted, type Event } from "../event"

const submissions = durableAtom({
  schema: Schema.Array(Schema.Union([PermissionSubmitted, BudgetSubmitted])), initial: [],
  reduce: (state, event: Event) => {
    if (event.type === "PermissionSubmitted" || event.type === "BudgetSubmitted") return [...state, event]
    if (event.type === "PermissionResolved") return state.filter(item => item.type !== "PermissionSubmitted" || item.callId !== event.callId)
    if (event.type === "BudgetResolved") return state.filter(item => item.type !== "BudgetSubmitted" || item.callId !== event.callId)
    return state
  },
})
const replies = new Map<string, ReturnType<typeof reply>>()
const reply = (ref: typeof PermissionSubmitted.Type["ref"]) => durablePromise(ref, { success: Schema.Json, error: Schema.String })

// requestPromises exposes request handles and their journal-backed results until domain resolution.
export const requestPromises = atom(get => get(submissions).map(item => {
  const id = JSON.stringify(item.ref)
  let promise = replies.get(id)
  if (!promise) { promise = reply(item.ref); replies.set(id, promise) }
  return { ...item, result: get(promise.state) }
}))
