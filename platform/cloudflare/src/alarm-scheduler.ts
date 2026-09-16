import { armAt } from "./alarm"

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

  constructor(private readonly storage: AlarmStorage, private readonly recoveryDelayMillis: number) {}

  private serialize<A>(action: () => Promise<A>): Promise<A> {
    const next = this.admission.then(action)
    this.admission = next.then(() => undefined, () => undefined)
    return next
  }

  async admit<A>(stage: () => Promise<A>, publish: () => void = () => {}): Promise<A> {
    return this.serialize(async () => {
      const result = await stage()
      await this.storage.setAlarm(Date.now())
      await this.storage.sync()
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
        const at = armAt(await this.storage.getAlarm(), Date.now(), this.recoveryDelayMillis)
        if (at !== null) await this.storage.setAlarm(at)
        await this.storage.sync()
      })
      await execute()
      await this.serialize(async () => {
        if (version === this.version) await synchronize()
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
