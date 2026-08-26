import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { hydrate, refs, spill, WORKSPACE_REFS } from "./store"

// The spill seam over a KeyValueStore: what goes in comes back out whole, and the reserved
// manifest key indexes the refs one store holds.

const run = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStore.layerMemory)))

describe("spill and hydrate", () => {
  test("a spilled value round-trips exactly", async () => {
    const json = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, text: "wideé\n\"quoted\"" })) })
    const read = await run(
      Effect.gen(function* () {
        yield* spill("e1.result", json)
        return yield* hydrate("e1.result")
      })
    )
    expect(read).toBe(json)
  })

  test("a ref the store never held reads as undefined", async () => {
    expect(await run(hydrate("nothing.here"))).toBeUndefined()
  })
})

describe("the ref manifest", () => {
  test("a spill adds its ref, and re-spilling the same ref adds nothing", async () => {
    const held = await run(
      Effect.gen(function* () {
        yield* spill("a", "1")
        yield* spill("b", "2")
        yield* spill("a", "1 again")
        return yield* refs()
      })
    )
    expect(held).toEqual(["a", "b"])
  })

  test("a store with no manifest reads as empty", async () => {
    expect(await run(refs())).toEqual([])
  })

  test("the manifest lives under the reserved key, as JSON", async () => {
    const raw = await run(
      Effect.gen(function* () {
        yield* spill("a", "1")
        return yield* Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.get(WORKSPACE_REFS))
      })
    )
    expect(raw).toBe(JSON.stringify(["a"]))
  })

  test("re-spilling replaces the value the ref names", async () => {
    const read = await run(
      Effect.gen(function* () {
        yield* spill("a", "1")
        yield* spill("a", "2")
        return yield* hydrate("a")
      })
    )
    expect(read).toBe("2")
  })
})
