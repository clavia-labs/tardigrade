import { Context, Effect, Layer, Schema } from "effect"
import { DEFAULT_CHECKPOINT_POLICY, defineActor, durableAtom, effectAtom, RuntimeError, type CheckpointPolicy, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-core"
import { createTestStore } from "./store"

const Tick = Schema.Struct({ type: Schema.Literal("Tick") })

// checkpointPolicy checks cadence, suffix recovery, and manual capture through the runtime on both hosts.
export const checkpointPolicy = () => Effect.runPromise(Effect.gen(function* () {
  for (const policy of [undefined, { mode: "threshold", options: { everyEvents: 3 } }, { mode: "threshold", options: { everyEvents: 1 } }, { mode: "manual" }] as const) {
    const effective: CheckpointPolicy = policy ?? DEFAULT_CHECKPOINT_POLICY
    const every = effective.mode === "threshold" ? effective.options.everyEvents : 3
    const records: Recorded<typeof Tick.Type>[] = []
    const writes: number[] = []
    const cursors: number[] = []
    const writeCount = () => writes.length
    let saved: StoredCheckpoint | undefined
    const append = (position: number, events: readonly Recorded<typeof Tick.Type>[], checkpoint?: StoredCheckpoint) => Effect.sync(() => {
      if (position !== records.length) throw new RuntimeError("Unexpected checkpoint journal position")
      records.push(...events)
      if (checkpoint) { saved = checkpoint; writes.push(checkpoint.position) }
    })
    const journal: Journal<typeof Tick.Type> = {
      read: Effect.sync(() => [...records]),
      readAfter: position => Effect.sync(() => { cursors.push(position); return records.slice(position) }),
      readCheckpoint: Effect.sync(() => saved), append, appendWithCheckpoint: append,
    }
    const actor = defineActor("checkpoint-policy", Effect.sync(() => {
      const count = durableAtom({ name: "checkpoint.count", input: Tick, schema: Schema.Finite, initial: 0, reduce: count => count + 1 })
      return { schema: Tick, atom: effectAtom(get => ({ view: get(count), events: {}, acts: {} })) }
    }))
    const open = (checkpoint: CheckpointPolicy | undefined = policy) => createTestStore({ actor, journal, ...(checkpoint ? { checkpoint } : {}), actorContext: () => Context.empty(), services: () => Layer.empty })
    if (!policy) {
      const removed = yield* open({ mode: "quiescent" } as unknown as CheckpointPolicy).pipe(Effect.result)
      if (removed._tag === "Success") { yield* removed.success.close; throw new RuntimeError("Removed checkpoint mode was accepted") }
    }
    let store = yield* open()
    const send = (count: number) => store.send(Array.from({ length: count }, () => ({ type: "Tick" as const })))
    yield* Effect.gen(function* () {
      yield* send(every - 1)
      if (writeCount() !== 0) throw new RuntimeError("Checkpoint captured before its threshold")
      yield* send(1)
      if (effective.mode === "threshold" && writes.join() !== String(every)) throw new RuntimeError("Threshold did not capture at its boundary")
      if (effective.mode === "manual") {
        if (writeCount() !== 0) throw new RuntimeError("Manual policy captured automatically")
        yield* store.checkpoint
      }
      yield* send(1)
      const before = JSON.stringify(records)
      const state = store.getState()
      const position = saved!.position
      yield* store.close
      store = yield* open()
      if (JSON.stringify(store.getState()) !== JSON.stringify(state) || JSON.stringify(records) !== before || cursors.join() !== String(position)) throw new RuntimeError("Suffix recovery changed state, history, or checkpoint cursor")
      if (effective.mode === "threshold") {
        yield* send(every - 1)
        const expected = Array.from({ length: 2 }, (_, index) => every * (index + 1)).join()
        if (writes.join() !== expected) throw new RuntimeError("Recovery reset the threshold cadence")
      } else if (writeCount() !== 1) throw new RuntimeError("Recovery captured under manual policy")
    }).pipe(Effect.ensuring(Effect.suspend(() => store.close)))
  }
}).pipe(Effect.scoped))
