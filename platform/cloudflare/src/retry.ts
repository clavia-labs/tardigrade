import { Effect } from "effect"
import { ioRetryPolicy, retryIo, type IoRetryPolicy } from "@clavia/tardigrade-host/retry"
import type { CloudflareErrorClassification } from "./layers/error"
import { makeAlarmPersistence, makeDurableObjectAlarms, type AlarmStorage, type DurableObjectAlarmsOptions } from "./layers/alarms"
import { makeDurableObjectRpc, type DurableObjectRpcOptions } from "./layers/rpc"
import { structuredWorkerConfigOf } from "./config"

export type CloudflareRetryPolicy = false | Partial<IoRetryPolicy>
export interface CloudflareRetryOptions { readonly retry?: CloudflareRetryPolicy }

// cloudflareRetryPolicy reads the host's ioRetry configuration before any attempt starts.
export const cloudflareRetryPolicy = (config: unknown): CloudflareRetryPolicy => {
  const value = structuredWorkerConfigOf(config)?.["ioRetry"]
  if (value === false) return false
  if (value === undefined) return ioRetryPolicy()
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("ioRetry must be false or a retry policy object")
  const defaults = ioRetryPolicy()
  for (const [key, field] of Object.entries(value)) {
    if (!(Object.hasOwn(defaults, key)) || typeof field !== "number") throw new Error(`Invalid ioRetry field: ${key}`)
  }
  return ioRetryPolicy(value)
}

// retryCloudflareOperation applies host retry policy only when the caller declares the operation replay-safe.
export const retryCloudflareOperation = <A, E extends CloudflareErrorClassification, R>(effect: Effect.Effect<A, E, R>, options: CloudflareRetryOptions & {
  readonly operation: string
  readonly replaySafe: boolean
}) => options.retry === false || !options.replaySafe ? effect : retryIo(effect, {
  operation: options.operation, classifyError: error => error, ...(options.retry === undefined ? {} : { policy: options.retry })
})

export type CloudflareAlarmOptions = DurableObjectAlarmsOptions & CloudflareRetryOptions

// retryAlarm waits for mutating storage calls to complete before releasing the caller's serialization, including on timeout or interruption.
const retryAlarm = <A, E extends CloudflareErrorClassification>(effect: Effect.Effect<A, E>, operation: string, options: CloudflareRetryOptions, mutating = false) =>
  retryCloudflareOperation(mutating ? Effect.uninterruptible(effect) : effect, { ...options, operation, replaySafe: true })

export const makeRetryingAlarmPersistence = (storage: Pick<AlarmStorage, "getAlarm" | "setAlarm" | "sync">, options: CloudflareAlarmOptions = {}) => {
  const alarms = makeAlarmPersistence(storage, options)
  return {
    get: retryAlarm(alarms.get, "DurableObjectAlarms.getAlarm", options),
    set: (at: number) => retryAlarm(alarms.set(at), "DurableObjectAlarms.setAlarm", options, true),
    sync: retryAlarm(alarms.sync, "DurableObjectAlarms.sync", options)
  }
}

// makeRetryingAlarms requires the host to serialize alarm changes; deadlines can wait for an in-flight binding call to settle.
export const makeRetryingAlarms = (storage: AlarmStorage, options: CloudflareAlarmOptions = {}) => {
  const alarms = makeDurableObjectAlarms(storage, options)
  return { ...makeRetryingAlarmPersistence(storage, options), delete: retryAlarm(alarms.delete, "DurableObjectAlarms.deleteAlarm", options, true) }
}

// makeRetryingRpc reacquires a stub per attempt; each call must state whether replay is safe.
export const makeRetryingRpc = (options: DurableObjectRpcOptions & CloudflareRetryOptions = {}) => {
  const rpc = makeDurableObjectRpc(options)
  return {
    call: <Stub, A>(namespace: { readonly getByName: (name: string) => Stub }, name: string, operation: string, invoke: (stub: Stub) => PromiseLike<A>, replaySafe: boolean) =>
      retryCloudflareOperation(rpc.call(namespace, name, operation, invoke), { ...options, operation: `DurableObjectRpc.${operation}`, replaySafe })
  }
}
