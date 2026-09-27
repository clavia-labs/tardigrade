import { Schema } from "effect"
import { atom, durableAtom, durablePromise } from "@clavia/tardigrade-experimental-core"
import { PermissionPromiseResolved, BudgetPromiseResolved, type Event } from "../event"

const submissions = durableAtom({
  schema: Schema.Array(Schema.Union([PermissionPromiseResolved, BudgetPromiseResolved])), initial: [],
  reduce: (state, event: Event) => {
    if ((event.type === "PermissionResolved" || event.type === "BudgetResolved") && "promise" in event) return [...state, event]
    return state
  },
})
const replies = new Map<string, ReturnType<typeof reply>>()
const reply = (ref: typeof PermissionPromiseResolved.Type["promise"]["ref"]) => durablePromise(ref, { success: Schema.Json, error: Schema.String })

// requestPromises exposes governance handles and their journal-backed results.
export const requestPromises = atom(get => get(submissions).map(item => {
  const id = JSON.stringify(item.promise.ref)
  let promise = replies.get(id)
  if (!promise) { promise = reply(item.promise.ref); replies.set(id, promise) }
  return { ...item, ...item.promise, result: get(promise.state) }
}))
