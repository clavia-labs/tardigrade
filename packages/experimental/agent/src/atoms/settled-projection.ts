import { Schema } from "effect"
import { atom, durableAtom } from "@clavia/tardigrade-experimental-core"
import { ModelPromiseReturned, ModelReply, PermissionPromiseResolved, BudgetPromiseResolved, Decision, BudgetDecision, Event } from "../event"

// settledProjection supplies completed model and governance values to domain reducers without appending duplicate domain events.
export function settledProjection<State, Input extends Event>(options: {
  readonly input: Schema.Schema<Input>
  readonly schema: Schema.Schema<State>
  readonly initial: NoInfer<State>
  readonly reduce: (state: NoInfer<State>, event: NoInfer<Input>) => NoInfer<State>
}) {
  const accepts = Schema.is(options.input)
  const reduce = (state: State, event: Event) => accepts(event) ? options.reduce(state, event) : state
  const frame = durableAtom({
    input: Event,
    schema: Schema.Struct({ value: options.schema, pending: Schema.Array(Schema.Union([ModelPromiseReturned, PermissionPromiseResolved, BudgetPromiseResolved])) }),
    initial: { value: options.initial, pending: [] },
    reduce: (state, event: Event) => {
      if ((event.type === "ModelReturned" || event.type === "PermissionResolved" || event.type === "BudgetResolved") && "promise" in event) return { ...state, pending: [...state.pending, event] }
      if (event.type === "PromiseSettled") {
        const returned = state.pending.find(item => item.promise.ref.atom === event.ref.atom && item.promise.ref.seq === event.ref.seq && item.promise.ref.tag === event.ref.tag)
        if (returned) {
          const pending = state.pending.filter(item => item !== returned)
          if (returned.type !== "ModelReturned") {
            let resolved: Event
            try {
              if (event.result.status === "rejected") throw new Error(event.result.error)
              resolved = returned.type === "PermissionResolved"
                ? { type: "PermissionResolved", callId: returned.callId, decision: Schema.decodeUnknownSync(Decision)(event.result.value) }
                : { type: "BudgetResolved", callId: returned.callId, decision: Schema.decodeUnknownSync(BudgetDecision)(event.result.value) }
              return { value: reduce(state.value, resolved), pending }
            } catch (error) {
              const decision = { allowed: false as const, reason: `Request failed: ${String(error)}` }
              resolved = returned.type === "BudgetResolved" ? { type: "BudgetResolved", callId: returned.callId, decision } : { type: "PermissionResolved", callId: returned.callId, decision }
              return { value: reduce(state.value, resolved), pending }
            }
          }
          if (event.result.status === "rejected") return { ...state, pending }
          const reply = Schema.decodeUnknownSync(ModelReply)(event.result.value)
          const resolved: Event = returned.purpose === "inference"
            ? { type: "ModelReturned", purpose: "inference", callId: returned.callId, text: reply.text,
                toolCalls: reply.toolCalls.map((call, index) => ({ ...call, callId: `${returned.callId}:tool:${index}` })) }
            : { type: "ModelReturned", purpose: "compaction", callId: returned.callId, text: reply.text }
          return { value: reduce(state.value, resolved), pending }
        }
      }
      const value = reduce(state.value, event)
      return Object.is(value, state.value) ? state : { ...state, value }
    },
  })
  return atom(get => get(frame).value)
}
