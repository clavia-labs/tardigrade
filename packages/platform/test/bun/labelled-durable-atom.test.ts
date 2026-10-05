import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Atom as NativeAtom } from "effect/unstable/reactivity"
import { actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { createBunHost } from "../../src/bun"

const Added = event({ type: "Added", amount: Schema.Finite })
const total = durableAtom({ name: "probe.total", input: Added, schema: Schema.Finite, initial: 0, reduce: (s, e) => s + e.amount }).pipe(NativeAtom.withLabel("total"))
const actor = defineActor("labelled", Effect.succeed({
  atom: effectAtom(get => ({ view: get(total), events: {}, acts: {} })),
  methods: { add: actorMethod({
    inputSchema: Schema.Finite, outputSchema: Schema.Finite,
    onReceive: Added.from(amount => ({ amount })),
    result: (_, get) => ({ status: "completed", output: get(total) }),
  }) },
}))

test("labelled durable atom checkpoints repeatedly", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-labelled-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } } }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    for (let i = 1; i <= 2; i++) { await Effect.runPromise(ref.invoke("add", i, { id: `a${i}` })); await Effect.runPromise(ref.wait) }
    await Effect.runPromise(host.invalidate(ref.coordinate))
    await Effect.runPromise(host.recover(ref.coordinate))
    expect(ref.getState().view).toBe(3)
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})
