import { ToolError } from "./errors"
import { Clock, Effect, Schema } from "effect"
import { Deadline, EffectExecution, EffectRef, durableAtom } from "@clavia/tardigrade-experimental-core"
import { Resolver, Resolution, type ResolutionRequest } from "@clavia/tardigrade-experimental-host"
import { tool } from "./tool"
import { definePackage } from "./package"

export const Alarm = Schema.Struct({
  alarmId: Schema.NonEmptyString,
  at: Deadline,
  message: Schema.NonEmptyString,
})
export type Alarm = typeof Alarm.Type

export const AlarmSet = Schema.Struct({ type: Schema.Literal("AlarmSet"), alarm: Alarm, ref: EffectRef })
export const AlarmCancelled = Schema.Struct({ type: Schema.Literal("AlarmCancelled"), alarmId: Schema.NonEmptyString })
const AlarmEntry = Schema.Struct({ alarm: Alarm, ref: EffectRef, status: Schema.Literals(["pending", "cancelled", "rang", "failed"]), error: Schema.NullOr(Schema.String) })

// alarmState retains reminder meaning while resolver settlements determine completion.
export const alarmState = durableAtom({
  schema: Schema.Array(AlarmEntry), initial: [],
  reduce: (state, event: unknown) => {
    if (Schema.is(AlarmSet)(event)) {
      if (state.some(item => item.alarm.alarmId === event.alarm.alarmId)) throw new ToolError("Alarm identity already used")
      return [...state, { alarm: event.alarm, ref: event.ref, status: "pending" as const, error: null }]
    }
    if (Schema.is(AlarmCancelled)(event)) {
      if (!state.some(item => item.alarm.alarmId === event.alarmId && item.status === "pending")) throw new ToolError("No matching pending alarm")
      return state.map(item => item.alarm.alarmId === event.alarmId ? { ...item, status: "cancelled" as const } : item)
    }
    if (!Schema.is(Resolution)(event)) return state
    return state.map(item => {
      if (item.status !== "pending" || item.ref.atom !== event.ref.atom || item.ref.seq !== event.ref.seq || item.ref.tag !== event.ref.tag) return item
      if (event.result.status === "rejected") return { ...item, status: "failed" as const, error: event.result.error }
      const value = Schema.decodeUnknownSync(Schema.Struct({ at: Deadline }))(event.result.value)
      if (value.at !== item.alarm.at) throw new ToolError("Clock settlement deadline mismatch")
      return { ...item, status: "rang" as const }
    })
  },
})

export const alarmRequest = (item: Pick<typeof AlarmEntry.Type, "alarm" | "ref">): ResolutionRequest => ({
  ref: item.ref, handle: { executor: "clock", id: item.alarm.alarmId, at: item.alarm.at },
})

// alarm records reminder intent and registers clock promises with the host resolver.
export function alarm() {
  return definePackage({ name: "alarm", description: "Schedule and cancel recorded reminders.", methods: [
    tool({
      name: "set_alarm",
      description: "Record a reminder and return its alarmId immediately. Supply message and either afterSeconds or an ISO timestamp with a timezone in at. An overdue alarm rings when the host is running.",
      input: Schema.Union([
        Schema.Struct({ message: Schema.NonEmptyString, afterSeconds: Schema.Finite }),
        Schema.Struct({ message: Schema.NonEmptyString, at: Schema.String }),
      ]),
      run: (input, call) => Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const value = yield* Effect.try({
          try: () => {
            if (!input.message.trim()) throw new ToolError("Alarm message must not be empty")
            let at: number
            if ("afterSeconds" in input) {
              if (!Number.isFinite(input.afterSeconds) || input.afterSeconds <= 0) throw new ToolError("afterSeconds must be finite and positive")
              at = Math.ceil(now + input.afterSeconds * 1000)
            } else {
              if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.at)) throw new ToolError("at must include an explicit timezone")
              at = Date.parse(input.at)
            }
            return { alarmId: `alarm:${call.callId}`, at, message: input.message }
          },
          catch: ToolError.from,
        })
        const validated = yield* Schema.decodeEffect(Alarm)(value).pipe(Effect.mapError(ToolError.from))
        const execution = yield* EffectExecution
        const resolver = yield* Resolver
        const event = { type: "AlarmSet", alarm: validated, ref: execution.ref } as const
        yield* execution.record(event)
        yield* resolver.watch(alarmRequest(event))
        return validated
      }),
    }),
    tool({
      name: "cancel_alarm",
      description: "Cancel a pending reminder by alarmId.",
      input: Schema.Struct({ alarmId: Schema.NonEmptyString }),
      run: ({ alarmId }) => Effect.gen(function* () {
        const execution = yield* EffectExecution
        const item = execution.get(alarmState).find(item => item.alarm.alarmId === alarmId && item.status === "pending")
        if (!item) return yield* Effect.fail(new ToolError("No matching pending alarm"))
        yield* execution.record({ type: "AlarmCancelled", alarmId })
        yield* (yield* Resolver).cancel(alarmRequest(item))
        return { alarmId, cancelled: true }
      }),
    }),
  ] })
}
