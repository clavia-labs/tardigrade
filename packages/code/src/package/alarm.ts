import { Chunk, Effect } from "effect"
import { component, type InteractionRequest } from "@clavia/tardigrade-core/actor"
import { Alarm } from "@clavia/tardigrade-core/alarm"
import type { Event } from "@clavia/tardigrade-core/event"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { definePackage, type Package } from "./definition"

const ALARM_ID_PREFIX = "alarms/"
const firingTag = (id: string): string => `wake:${id}`

export interface AlarmNotification {
  readonly id: string
  readonly wakeAt: number
  readonly note: string
}

export interface AlarmOptions {
  readonly onFired: (alarm: AlarmNotification) => InteractionRequest | undefined
}

interface Request extends AlarmNotification {
  readonly fired?: TransitionContext
}

interface RecordedEvent {
  readonly event: Event
  readonly context: TransitionContext
}

// pendingFiringsOf retains fired requests until their source-owned completion is recorded (alarm.test.ts).
const pendingFiringsOf = (log: ReadonlyArray<RecordedEvent>): ReadonlyArray<{ readonly request: Request; readonly context: TransitionContext }> => {
  const requests = new Map<string, Request>()
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
    }
    for (const [id, request] of requests) {
      if (request.fired?.matches(firingTag(id), event)) requests.delete(id)
    }
  }
  return [...requests.values()]
    .flatMap((request) => request.fired === undefined
      ? [] : [{ request, context: request.fired }])
}

// alarm exposes durable wake requests and derives the caller-selected interaction on each firing (alarm.test.ts).
export const alarm = (options: AlarmOptions): Package<Alarm> => {
  const calls = definePackage<Alarm>({
    name: "alarm",
    description: "Schedule a future alarm with a note for the configured firing handler.",
    annotations: {
      set: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
      cancel: { idempotentHint: true, destructiveHint: false, openWorldHint: false }
    },
    docs: {
      set: {
        description: "Schedule an alarm at a Unix timestamp in milliseconds with a note for its firing handler.",
        input: { type: "object", properties: { wakeAt: { type: "integer", minimum: 0 }, note: { type: "string", minLength: 1 } }, required: ["wakeAt", "note"], additionalProperties: false },
        output: { type: "object", properties: { id: { type: "string" }, wakeAt: { type: "integer" }, note: { type: "string" } }, required: ["id", "wakeAt", "note"] }
      },
      cancel: {
        description: "Cancel a pending wake by the id returned from alarm.set.",
        input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        output: { type: "object", properties: { id: { type: "string" }, cancelled: { type: "boolean" } }, required: ["id", "cancelled"] }
      }
    },
    methods: {
      set: (args, context) => Effect.gen(function* () {
        const input = args as { readonly wakeAt?: unknown; readonly note?: unknown } | undefined
        if (typeof input?.wakeAt !== "number" || !Number.isSafeInteger(input.wakeAt) || input.wakeAt < 0 ||
          typeof input.note !== "string" || input.note.length === 0) {
          return { error: "alarm.set needs { wakeAt: non-negative safe integer, note: nonempty string }" }
        }
        const id = `${ALARM_ID_PREFIX}${context.callId}`
        yield* Alarm.set(id, input.wakeAt, input.note)
        return { id, wakeAt: input.wakeAt, note: input.note }
      }),
      cancel: (args) => Effect.gen(function* () {
        const id = (args as { readonly id?: unknown } | undefined)?.id
        if (typeof id !== "string" || !id.startsWith(ALARM_ID_PREFIX)) return { error: "alarm.cancel needs an id returned by alarm.set" }
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
      const due = pendingFiringsOf(Chunk.toReadonlyArray(state))
      return {
        ...output,
        transitions: [...output.transitions, ...due.flatMap(({ request: { id, wakeAt, note }, context }) => {
          const response = options.onFired({ id, wakeAt, note })
          return response === undefined ? [] : [context.interaction(firingTag(id), response)]
        }) ]
      }
    }
  })
  return { ...calls, ...notifications, name: calls.name }
}
