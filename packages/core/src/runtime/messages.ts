import { Schema } from "effect"
import { CoreEvent } from "./events"
import { MessageAddress, MessageDelivered } from "../actor/message"
import { durableAtom } from "../atoms/durable"
import { effectAtom } from "../atoms/effect"
import type { ActorMethods } from "../actor/method"
import type { ThreadCoordinate } from "../actor/thread"
import { DeliverMessage } from "../services/invocation"

const Obligation = Schema.Struct({ id: Schema.NonEmptyString, target: MessageAddress, method: Schema.NonEmptyString, input: Schema.Json })

// messageReplies retains return addresses until accepted delivery discharges their obligations.
export function messageReplies<Event extends object>(options: {
  readonly schema: Schema.Schema<Event>
  readonly address?: ThreadCoordinate
  readonly methods: ActorMethods<Event>
}) {
  const obligations = durableAtom({
    name: "host.message.obligations",
    input: Schema.Union([options.schema, CoreEvent]), schema: Schema.Array(Obligation), initial: [],
    reduce: (state, event, metadata) => {
      if (Schema.is(MessageDelivered)(event)) return state.filter(request => request.id !== event.id)
      const message = metadata.message
      if (!message?.invocation || message.inReplyTo || !Schema.is(MessageAddress)(message.from)) return state
      if (state.some(request => request.id === message.id)) throw new Error("Duplicate reply obligation")
      return [...state, { id: message.id, target: message.from, ...message.invocation }]
    },
  })
  const requests = new Map<string, ReturnType<typeof DeliverMessage.request>>()
  return effectAtom(get => {
    if (!options.address) return { view: null, events: {}, acts: {} }
    const pendingReplies = get(obligations)
    const remaining = new Set(pendingReplies.map(pending => pending.id))
    for (const id of requests.keys()) if (!remaining.has(id)) requests.delete(id)
    const acts = Object.fromEntries(pendingReplies.flatMap(pending => {
      const tag = pending.id.split("").map(unit => unit.charCodeAt(0).toString(16).padStart(4, "0")).join("")
      let request = requests.get(pending.id)
      if (!request) {
        const method = options.methods[pending.method]
        if (!method) throw new Error(`Unknown actor method: ${pending.method}`)
        const body = method.result(pending.input, get, { id: pending.id, ref: { method: pending.method, id: pending.id } })
        if (body === undefined) return []
        request = DeliverMessage.request({
          tag,
          input: { id: JSON.stringify(["reply", options.address, pending.id]), target: pending.target, body, inReplyTo: pending.id },
          onSettled: (result, ref) => result.status === "fulfilled" ? [{ type: "MessageDelivered", id: pending.id, ref, receipt: result.value } satisfies MessageDelivered] : [],
        })
        requests.set(pending.id, request)
      }
      return [[tag, request]]
    }))
    return { view: null, events: {}, acts }
  })
}
