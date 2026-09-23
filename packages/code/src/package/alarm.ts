import { Chunk, Effect } from "effect"
import { component } from "@clavia/tardigrade-core/actor"
import { Alarm } from "@clavia/tardigrade-core/alarm"
import type { Event } from "@clavia/tardigrade-core/event"
import { messageReceived } from "@clavia/tardigrade-core/interaction/provider-message"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { definePackage, type Package } from "./definition"

const ALARM_ID_PREFIX = "alarms/"
const wakeMessageId = (id: string): string => `alarms/wake/${id}`

interface Request {
  readonly id: string
  readonly wakeAt: number
  readonly note: string
  readonly fired?: TransitionContext
}

interface RecordedEvent {
  readonly event: Event
  readonly context: TransitionContext
}

// dueMessagesOf derives one agent turn for every fired package alarm without a wake message.
const dueMessagesOf = (log: ReadonlyArray<RecordedEvent>): ReadonlyArray<{ readonly request: Request; readonly context: TransitionContext }> => {
  const requests = new Map<string, Request>()
  const delivered = new Set<string>()
  for (const { event, context } of log) {
    if (event.type === "AlarmSet" && typeof event.id === "string" && event.id.startsWith(ALARM_ID_PREFIX) &&
      typeof event.wakeAt === "number") {
      requests.set(event.id, { id: event.id, wakeAt: event.wakeAt, note: typeof event.note === "string" ? event.note : "" })
    } else if (event.type === "AlarmCancelled" && typeof event.id === "string") {
      requests.delete(event.id)
    } else if (event.type === "AlarmFired" && typeof event.at === "number") {
      for (const [id, request] of requests) {
        if (request.wakeAt <= event.at && request.fired === undefined) requests.set(id, { ...request, fired: context })
      }
    } else if (event.type === "MessageReceived" && typeof event.id === "string") {
      delivered.add(event.id)
    }
  }
  return [...requests.values()]
    .flatMap((request) => request.fired === undefined || delivered.has(wakeMessageId(request.id))
      ? [] : [{ request, context: request.fired }])
}

// alarms exposes durable wake requests to code and tool calls and turns each firing into an agent message.
export const alarms = (): Package<Alarm> => {
  const calls = definePackage<Alarm>({
    name: "alarms",
    description: "Schedule a future wake for this agent. The note arrives as a new message when the alarm fires.",
    annotations: {
      set: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
      cancel: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    docs: {
      set: {
        description: "Schedule a wake at a Unix timestamp in milliseconds. The note becomes a new agent message when it fires.",
        input: { type: "object", properties: { wakeAt: { type: "integer", minimum: 0 }, note: { type: "string", minLength: 1 } }, required: ["wakeAt", "note"], additionalProperties: false },
        output: { type: "object", properties: { id: { type: "string" }, wakeAt: { type: "integer" }, note: { type: "string" } }, required: ["id", "wakeAt", "note"] }
      },
      cancel: {
        description: "Cancel a pending wake by the id returned from alarms.set.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        output: { type: "object", properties: { id: { type: "string" }, cancelled: { type: "boolean" } }, required: ["id", "cancelled"] }
      }
    },
    methods: {
      set: (args, context) => Effect.gen(function* () {
        const input = args as { readonly wakeAt?: unknown; readonly note?: unknown } | undefined
        if (typeof input?.wakeAt !== "number" || !Number.isSafeInteger(input.wakeAt) || input.wakeAt < 0 ||
          typeof input.note !== "string" || input.note.length === 0) {
          return { error: "alarms.set needs { wakeAt: non-negative safe integer, note: nonempty string }" }
        }
        const id = `${ALARM_ID_PREFIX}${context.callId}`
        yield* Alarm.set(id, input.wakeAt, input.note)
        return { id, wakeAt: input.wakeAt, note: input.note }
      }),
      cancel: (args) => Effect.gen(function* () {
        const id = (args as { readonly id?: unknown } | undefined)?.id
        if (typeof id !== "string" || !id.startsWith(ALARM_ID_PREFIX)) return { error: "alarms.cancel needs an id returned by alarms.set" }
        return { id, cancelled: yield* Alarm.cancel(id) }
      })
    }
  })
  const notifications = component({
    name: "alarms.notifications",
    children: calls,
    initial: () => Chunk.empty<RecordedEvent>(),
    step: (state, event, context) => Chunk.append(state, { event, context }),
    output: (state, child) => {
      const output = child.output()
      const due = dueMessagesOf(Chunk.toReadonlyArray(state))
      return {
        ...output,
        transitions: [...output.transitions, ...due.map(({ request, context }) =>
          context.intent(`wake:${request.id}`, (at) => messageReceived({
            id: wakeMessageId(request.id), text: request.note, at
          }))) ]
      }
    }
  })
  return { ...calls, ...notifications, name: calls.name }
}
