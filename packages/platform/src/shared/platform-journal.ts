import { Effect, Scheduler } from "effect"
import { synchronousJournal } from "./synchronous-journal"
import { DEFAULT_CHECKPOINT_COLLECT_EVERY, DEFAULT_CHECKPOINT_SCHEDULER, type CheckpointTreeOptions } from "./storage-policy"

// platformJournal applies host collection and Effect scheduling policies to the native journal (test/bun/tree-state.test.ts).
export function platformJournal<Event extends object>(options: Parameters<typeof synchronousJournal<Event>>[0], tree: CheckpointTreeOptions = {}, ready: Effect.Effect<void, Error> = Effect.void) {
  const { scheduler = DEFAULT_CHECKPOINT_SCHEDULER, collectEvery = DEFAULT_CHECKPOINT_COLLECT_EVERY, ...grove } = tree
  const journal = synchronousJournal<Event>({ ...grove, ...options, collectEvery: options.collectEvery ?? collectEvery })
  const resume = <Value, Failure>(work: Effect.Effect<Value, Failure>) => ready.pipe(Effect.andThen(work), Effect.provideService(Scheduler.Scheduler, scheduler))
  return { ...journal,
    read: resume(journal.read), readAfter: (position: number) => resume(journal.readAfter(position)),
    readInputs: resume(journal.readInputs), readCheckpoint: resume(journal.readCheckpoint),
    readFirst: resume(journal.readFirst), readVersion: resume(journal.readVersion),
    readMessage: (id: string) => resume(journal.readMessage(id)),
    acknowledge: resume(journal.acknowledge), collect: resume(journal.collect),
    append: (...args: Parameters<typeof journal.append>) => resume(journal.append(...args)),
    appendWithCheckpoint: (...args: Parameters<typeof journal.appendWithCheckpoint>) => resume(journal.appendWithCheckpoint(...args)),
  }
}
