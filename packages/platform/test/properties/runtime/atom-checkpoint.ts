import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import { Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { event, createEventLog, durableAtom, effectAtom, type Atom } from "@clavia/tardigrade-core"

const Added = event({ type: "Added", amount: Schema.Int })
const copies: readonly ((node: Atom<number>) => Atom<number>)[] = [node => node, NativeAtom.withLabel("copy"), NativeAtom.keepAlive]
const total = () => durableAtom({ name: "probe.total", input: Added, schema: Schema.Int, initial: 0, reduce: (state, event) => state + event.amount })

// atomCheckpoint checks alias deduplication and duplicate regular declarations.
export const atomCheckpoint = fc.property(fc.uniqueArray(fc.nat({ max: copies.length - 1 }), { minLength: 1 }), fc.boolean(), (reads, collide) => {
  const original = total()
  const exposed = [...reads.map(index => copies[index]!(original)), ...(collide ? [total()] : [])]
  const log = createEventLog({ schema: Added, atoms: { root: effectAtom(get => ({ view: exposed.map(node => get(node)), events: {}, acts: {} })) } })
  try {
    if (collide) assert.throws(() => log.initial.checkpoint(), /Duplicate durable atom checkpoint name/)
    else assert.deepEqual(log.initial.checkpoint()!.durable.map(entry => entry.state), [0])
  } finally { log.dispose() }
})
