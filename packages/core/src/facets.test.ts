import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "./event"
import { Facets } from "./facets"

// The observe privilege: a name in, that lane's committed events out. A binding that cannot
// reach the named lane answers in the same shape, so a reader never learns where a log lives.

const lanes: Readonly<Record<string, ReadonlyArray<Event>>> = {
  "ag.child": [{ type: "MessageReceived", id: "m1", text: "hello", at: 1 }]
}

const shared = Layer.succeed(Facets, { read: (name: string) => Effect.succeed(lanes[name] ?? []) })

describe("Facets", () => {
  test("Facets reads a sibling lane by name", async () => {
    const read = Effect.gen(function* () {
      const logs = yield* Facets
      return yield* logs.read("ag.child")
    })
    const events = await Effect.runPromise(read.pipe(Effect.provide(shared)))
    expect(events.map((e) => e.type)).toEqual(["MessageReceived"])
    expect((events[0] as { text?: unknown }).text).toBe("hello")
  })

  test("an unknown lane reads empty, never absent", async () => {
    const read = Effect.gen(function* () {
      const logs = yield* Facets
      return yield* logs.read("ag.nobody")
    })
    expect(await Effect.runPromise(read.pipe(Effect.provide(shared)))).toEqual([])
  })

  test("a remote binding refuses in the same shape", async () => {
    const remote = Layer.succeed(Facets, { read: () => Effect.succeed([] as ReadonlyArray<Event>) })
    const read = Effect.gen(function* () {
      const logs = yield* Facets
      return yield* logs.read("ag.child")
    })
    expect(await Effect.runPromise(read.pipe(Effect.provide(remote)))).toEqual([])
  })
})
