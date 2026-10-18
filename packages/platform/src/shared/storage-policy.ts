import { Scheduler } from "effect"
import type { SyncOptions } from "@tardie/grove/sqlite"

export const DEFAULT_CHECKPOINT_COLLECT_EVERY = 32
// DEFAULT_CHECKPOINT_SCHEDULER keeps journal work on microtasks because timer resumes can wait behind a Durable Object storage gate (test/workerd/thread-layout.workers.ts).
export const DEFAULT_CHECKPOINT_SCHEDULER = new Scheduler.MixedScheduler("sync")
export interface CheckpointTreeOptions extends Omit<SyncOptions, "scope" | "chunkBytes"> {
  readonly scheduler?: Scheduler.Scheduler
  readonly collectEvery?: number
}
