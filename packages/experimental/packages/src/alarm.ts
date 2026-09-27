import { isDeepStrictEqual } from "node:util"
import { ToolError } from "./errors"
import { Clock, Effect, Schema } from "effect"
import { Deadline, EffectExecution, durableAtom, durablePromise } from "@clavia/tardigrade-experimental-core"
import { Promises } from "@clavia/tardigrade-experimental-host"
import { tool, promiseTool, ToolPromise } from "./tool"
import { definePackage } from "./package"

const Alarm = Schema.Struct({ alarmId: Schema.NonEmptyString, at: Deadline, message: Schema.NonEmptyString })

const ReturnedPromise = Schema.Struct({ type: Schema.Literal("ToolReturned"), promise: ToolPromise })
const promises = durableAtom({
  input: ReturnedPromise,
  schema: Schema.Array(ToolPromise), initial: [],
  reduce: (state, event) => [...state, event.promise],
})

// alarm exposes reminders as clock promises and records cancellation through promise settlement.
export function alarm() {
  return definePackage({ name: "alarm", description: "Schedule and cancel reminders.", methods: [
    promiseTool({
      name: "set_alarm",
      description: "Schedule a reminder and return its promise immediately. Supply message and either afterSeconds or an ISO timestamp with a timezone in at. The reminder arrives in the inbox when the promise settles.",
      input: Schema.Union([
        Schema.Struct({ message: Schema.NonEmptyString, afterSeconds: Schema.Finite }),
        Schema.Struct({ message: Schema.NonEmptyString, at: Schema.String }),
      ]),
      submit: (input, call) => Effect.gen(function* () {
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
        return { executor: "clock", id: validated.alarmId, at: validated.at, value: validated }
      }),
    }),
    tool({
      name: "cancel_alarm",
      description: "Cancel a pending reminder using the complete promise returned by set_alarm.",
      input: Schema.Struct({ promise: ToolPromise }),
      run: ({ promise }) => Effect.gen(function* () {
        if (promise.handle.executor !== "clock") return yield* Effect.fail(new ToolError("Expected a clock promise"))
        const execution = yield* EffectExecution
        if (!execution.get(promises).some(value => isDeepStrictEqual(value, promise))) return yield* Effect.fail(new ToolError("Unknown alarm promise"))
        const state = execution.get(durablePromise(promise.ref, { success: Schema.Json, error: Schema.String }).state)
        if (state.status !== "pending") return { cancelled: false, reason: "Promise already settled" }
        yield* (yield* Promises).cancel(promise)
        yield* execution.record({ type: "PromiseSettled", ref: promise.ref, result: { status: "rejected", error: "Alarm cancelled" } })
        return { cancelled: true }
      }),
    }),
  ] })
}
