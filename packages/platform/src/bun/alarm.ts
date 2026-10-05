import { Effect, Fiber } from "effect"
import { DEFAULT_SCHEDULER_POLICY, RuntimeError, type Alarm } from "@clavia/tardigrade-core"

export const MAX_BUN_TIMER_DELAY_MS = 2_147_483_647

// bunAlarm maintains a physical timer; its scheduler owns persistence and restart restoration.
export function bunAlarm(wake: Effect.Effect<void, Error>, options: { readonly retryIntervalMs?: number | undefined } = {}) {
  const retryIntervalMs = options.retryIntervalMs ?? DEFAULT_SCHEDULER_POLICY.deliveryRetryMs
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1) throw new RuntimeError("Alarm retryIntervalMs must be a positive safe integer")
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const running = new Set<Fiber.Fiber<void, Error>>()
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined }
  const set = (at: number) => {
    clear()
    if (closed) return
    timer = setTimeout(() => {
      timer = undefined
      if (at > Date.now()) { set(at); return }
      const fiber = Effect.runFork(wake)
      running.add(fiber)
      fiber.addObserver(exit => { running.delete(fiber); if (exit._tag === "Failure" && timer === undefined) set(Date.now() + retryIntervalMs) })
    }, Math.max(0, Math.min(MAX_BUN_TIMER_DELAY_MS, at - Date.now())))
  }
  const alarm: typeof Alarm.Service = { set: at => Effect.sync(() => set(at)), clear: Effect.sync(clear) }
  return {
    alarm,
    close: Effect.sync(() => { closed = true; clear() }).pipe(Effect.andThen(Effect.suspend(() => Effect.forEach(running, Fiber.interrupt).pipe(Effect.asVoid)))),
  }
}
