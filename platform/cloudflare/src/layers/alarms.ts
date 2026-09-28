import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { Context, Effect, Layer } from "effect"
import { classifyDurableObjectAlarmError, DurableObjectAlarmError, type DurableObjectAlarmErrorClassification, type DurableObjectAlarmOperation } from "./alarms-error"

export type AlarmStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm" | "sync">

export interface DurableObjectAlarmsOptions {
  readonly classifyError?: (cause: unknown, operation: DurableObjectAlarmOperation) => DurableObjectAlarmErrorClassification
}

// DurableObjectAlarms exposes alarm persistence and flushing as typed effects.
export class DurableObjectAlarms extends Context.Service<DurableObjectAlarms, {
  readonly get: Effect.Effect<number | null, DurableObjectAlarmError>
  readonly set: (at: number) => Effect.Effect<void, DurableObjectAlarmError>
  readonly delete: Effect.Effect<void, DurableObjectAlarmError>
  readonly sync: Effect.Effect<void, DurableObjectAlarmError>
}>()("tardigrade/cloudflare/DurableObjectAlarms") {}

export const makeAlarmPersistence = (
  storage: Pick<AlarmStorage, "getAlarm" | "setAlarm" | "sync">,
  options: DurableObjectAlarmsOptions = {}
) => {
  const classify = options.classifyError ?? classifyDurableObjectAlarmError
  const call = <A>(operation: DurableObjectAlarmOperation, run: () => Promise<A>) => Effect.tryPromise({
    try: run,
    catch: (cause) => new DurableObjectAlarmError({ ...classify(cause, operation), operation, cause })
  })
  return {
    get: call("getAlarm", () => storage.getAlarm()),
    set: (at: number) => call("setAlarm", () => storage.setAlarm(at)),
    sync: call("sync", () => storage.sync())
  }
}

// makeAlarmScheduling binds alarm changes to storage or a storage transaction.
export const makeAlarmScheduling = (storage: Pick<AlarmStorage, "setAlarm" | "deleteAlarm">, options: DurableObjectAlarmsOptions = {}) => {
  const classify = options.classifyError ?? classifyDurableObjectAlarmError
  const call = (operation: "setAlarm" | "deleteAlarm", run: () => Promise<void>) => Effect.tryPromise({
    try: run,
    catch: (cause) => new DurableObjectAlarmError({ ...classify(cause, operation), operation, cause })
  })
  return {
    set: (at: number) => call("setAlarm", () => storage.setAlarm(at)),
    delete: call("deleteAlarm", () => storage.deleteAlarm())
  }
}

export const makeDurableObjectAlarms = (storage: AlarmStorage, options: DurableObjectAlarmsOptions = {}): typeof DurableObjectAlarms.Service => ({
  ...makeAlarmPersistence(storage, options),
  ...makeAlarmScheduling(storage, options)
})

export const layerDurableObjectAlarms = (storage: AlarmStorage, options: DurableObjectAlarmsOptions = {}): Layer.Layer<DurableObjectAlarms> =>
  Layer.succeed(DurableObjectAlarms, makeDurableObjectAlarms(storage, options))
