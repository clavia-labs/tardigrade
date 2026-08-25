import { expect, test } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { ActorRegistration } from "@clavia/tardigrade-core/actor/registry"
import { makeBunActorRegistry } from "./registry"

interface Registration extends ActorRegistration {
  readonly source: "built-in" | "artifact"
  readonly revision?: string
}

test("a Bun registry persists replacements and removals", async () => {
  const database = ManagedRuntime.make(SqliteClient.layer({ filename: ":memory:" }))
  try {
    const sql = await database.runPromise(SqliteClient.SqliteClient)
    const registry = await Effect.runPromise(makeBunActorRegistry<Registration>({ sql }))
    await Effect.runPromise(registry.put({ name: "reviewer", source: "artifact", revision: "one" }))
    await Effect.runPromise(registry.put({ name: "default", source: "built-in" }))
    await Effect.runPromise(registry.put({ name: "reviewer", source: "artifact", revision: "two" }))

    expect(await Effect.runPromise(registry.resolve("reviewer"))).toEqual({
      name: "reviewer",
      source: "artifact",
      revision: "two"
    })
    expect((await Effect.runPromise(registry.list)).map((registration) => registration.name)).toEqual(["default", "reviewer"])

    await Effect.runPromise(registry.remove("reviewer"))
    expect(await Effect.runPromise(registry.resolve("reviewer"))).toBeUndefined()
  } finally {
    await database.dispose()
  }
})
