import { Effect } from "effect"

export interface ThreadCommit {
  readonly actor: string
  readonly instance: string
  readonly thread: string
  readonly head: number
}

export interface CommitObserverPolicy {
  readonly deliveryTimeoutMs: number
}

export const DEFAULT_COMMIT_OBSERVER_POLICY: CommitObserverPolicy = {
  deliveryTimeoutMs: 5_000
}

export interface CommitObserver {
  readonly onCommit: (commit: ThreadCommit) => Effect.Effect<void>
  readonly policy?: Partial<CommitObserverPolicy>
}

const policyOf = (observer: CommitObserver): CommitObserverPolicy => {
  const policy = { ...DEFAULT_COMMIT_OBSERVER_POLICY, ...observer.policy }
  if (!Number.isSafeInteger(policy.deliveryTimeoutMs) || policy.deliveryTimeoutMs <= 0) {
    throw new Error(`commit observer deliveryTimeoutMs must be a positive integer, got ${policy.deliveryTimeoutMs}`)
  }
  return policy
}

// CommitDispatcher retains the latest pending head while one observer delivery runs. Observer failure and timeout cannot affect the durable append (commit.test.ts).
export class CommitDispatcher {
  readonly observer: CommitObserver
  readonly policy: CommitObserverPolicy
  readonly retain: (task: Promise<void>) => void
  private pending: ThreadCommit | undefined
  private running: Promise<void> | undefined
  private closed = false

  constructor(observer: CommitObserver, retain: (task: Promise<void>) => void = () => {}) {
    this.observer = observer
    this.policy = policyOf(observer)
    this.retain = retain
  }

  offer(commit: ThreadCommit): void {
    if (this.closed) return
    if (this.pending === undefined || commit.head > this.pending.head) this.pending = commit
    if (this.running !== undefined) return
    const running = this.drain()
    this.running = running
    this.retain(running)
    void running.then(
      () => {
        if (this.running === running) this.running = undefined
        if (this.pending !== undefined) this.offer(this.pending)
      },
      () => {
        if (this.running === running) this.running = undefined
        if (this.pending !== undefined) this.offer(this.pending)
      }
    )
  }

  async close(): Promise<void> {
    this.closed = true
    await this.running
    if (this.pending !== undefined) await this.drain()
  }

  private async drain(): Promise<void> {
    while (this.pending !== undefined) {
      const commit = this.pending
      this.pending = undefined
      await Effect.runPromise(
        Effect.suspend(() => this.observer.onCommit(commit)).pipe(
          Effect.timeout(this.policy.deliveryTimeoutMs),
          Effect.ignoreCause
        )
      )
    }
  }
}
