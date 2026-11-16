import { armAt } from "./alarm"
import { Effect } from "effect"
import { makeRetryingAlarmPersistence, type CloudflareAlarmOptions } from "./retry"

interface AlarmStorage {
  getAlarm(): Promise<number | null>
  setAlarm(at: number): Promise<void>
  sync(): Promise<void>
}

// AlarmScheduler separates durable admission from execution and preserves later wakes (test/invocation-depth.workers.ts; alarm-scheduler.test.ts).
export class AlarmScheduler {
  private admission: Promise<void> = Promise.resolve()
  private version = 0
  private running: Promise<void> | undefined
  private readonly waiters = new Map<number, { resolve(): void; reject(cause: unknown): void }>()

  private readonly alarms: ReturnType<typeof makeRetryingAlarmPersistence>

  constructor(storage: AlarmStorage, private readonly recoveryDelayMillis: number, options: CloudflareAlarmOptions = {}) {
    this.alarms = makeRetryingAlarmPersistence(storage, options)
  }

  private serialize<A>(action: () => Promise<A>): Promise<A> {
    const next = this.admission.then(action)
    this.admission = next.then(() => undefined, () => undefined)
    return next
  }

  async admit<A>(stage: () => Promise<A>, publish: () => void = () => {}): Promise<A> {
    return this.serialize(async () => {
      const result = await stage()
      await Effect.runPromise(this.alarms.set(Date.now()))
      await Effect.runPromise(this.alarms.sync)
      this.version++
      publish()
      return result
    })
  }

  async wakeAndWait(): Promise<void> {
    let resolve!: () => void
    let reject!: (cause: unknown) => void
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
    const completion = { promise, resolve, reject }
    // Attach before admission so a fast failed alarm cannot leave an unhandled rejection.
    void completion.promise.catch(() => {})
    await this.admit(async () => {}, () => { this.waiters.set(this.version, completion) })
    await completion.promise
  }

  run(execute: () => Promise<void>, synchronize: () => Promise<void>): Promise<void> {
    if (this.running !== undefined) return this.running
    this.running = this.pass(execute, synchronize).finally(() => { this.running = undefined })
    return this.running
  }

  private async pass(execute: () => Promise<void>, synchronize: () => Promise<void>): Promise<void> {
    let version = 0
    try {
      await this.serialize(async () => {
        version = this.version
        const at = armAt(await Effect.runPromise(this.alarms.get), Date.now(), this.recoveryDelayMillis)
        if (at !== null) await Effect.runPromise(this.alarms.set(at))
        await Effect.runPromise(this.alarms.sync)
      })
      await execute()
      await this.serialize(async () => {
        if (version === this.version) return synchronize()
        // A mid-pass admission's wake may have joined this pass, so re-arm it (tla/AlarmScheduler.tla, Complete; alarm-scheduler.test.ts).
        await Effect.runPromise(this.alarms.set(Date.now()))
        await Effect.runPromise(this.alarms.sync)
      })
      for (const [admitted, waiter] of this.waiters) {
        if (admitted <= version) { waiter.resolve(); this.waiters.delete(admitted) }
      }
    } catch (cause) {
      for (const [admitted, waiter] of this.waiters) {
        if (admitted <= version) { waiter.reject(cause); this.waiters.delete(admitted) }
      }
      throw cause
    }
  }
}
