import * as fc from "fast-check"
import { isDeepStrictEqual } from "node:util"
import { Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { createEventLog, decodeCheckpoint, durableAtom, effectAtom, encodeCheckpoint, type Atom } from "@clavia/tardigrade-core"

const Added = Schema.Struct({ type: Schema.Literal("Added"), amount: Schema.Int })
const copies: readonly ((node: Atom<number>) => Atom<number>)[] = [node => node, NativeAtom.withLabel("copy"), NativeAtom.keepAlive]
const total = () => durableAtom({ name: "probe.total", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event) => state + event.amount })

export const durableCapture = fc.property(fc.uniqueArray(fc.nat({ max: copies.length - 1 }), { minLength: 1 }), fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 8 }), fc.boolean(), (reads, amounts, collide) => {
  const original = total()
  const exposed = [...reads.map(index => copies[index]!(original)), ...(collide ? [total()] : [])]
  const options = { schema: Added, atoms: { root: effectAtom(get => ({ view: exposed.map(node => get(node)), events: {}, acts: {} })) } }
  const log = createEventLog(options)
  try {
    const snapshots = [log.initial]
    for (const amount of amounts) snapshots.push(log.append(snapshots.at(-1)!, { type: "Added", amount }))
    if (collide) {
      try { snapshots[0]!.checkpoint() } catch (error) { if (String(error).includes("Duplicate durable atom checkpoint name")) return; throw error }
      throw new Error("Distinct atoms sharing a name were captured")
    }
    for (const [cut, snapshot] of snapshots.entries()) {
      const captured = snapshot.checkpoint()!
      if (!isDeepStrictEqual(captured.durable.map(entry => entry.state), [amounts.slice(0, cut).reduce((sum, amount) => sum + amount, 0)])) throw new Error("Checkpoint did not hold one folded entry")
      const restored = createEventLog({ ...options, checkpoint: decodeCheckpoint(encodeCheckpoint(captured)) })
      let resumed = restored.initial
      for (const amount of amounts.slice(cut)) resumed = restored.append(resumed, { type: "Added", amount })
      restored.dispose()
      if (!isDeepStrictEqual(resumed.view().root.view, snapshots.at(-1)!.view().root.view)) throw new Error("Checkpoint restore differs from full replay")
    }
  } finally { log.dispose() }
})
