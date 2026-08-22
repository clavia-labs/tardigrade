import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { spill } from "./store"
import { DEFAULT_WORKSPACE_POLICY, WORKSPACE_SQL_DESCRIPTION, workspacePackage, type SqlRunner } from "./workspace"

// The model's view of the store: a bounded slice of one value, a search across all of them, and a
// sql verb only where a platform bound one.

// A method states the store in its type rather than closing over one, so a call binds the store
// the way the code funnel does: by providing it to the method's own effect (packages.ts, Package).
const call = async (
  pkg: ReturnType<typeof workspacePackage>,
  method: string,
  args: unknown,
  store: KeyValueStore.KeyValueStore
) =>
  (await Effect.runPromise(
    pkg.methods[method]!(args, { callId: "c1" }).pipe(
      Effect.provideService(KeyValueStore.KeyValueStore, store)
    )
  )) as Record<string, unknown>

// A store built straight from the memory layer, seeded through the spill path so the manifest is
// the one grep reads.
const seeded = (values: Readonly<Record<string, string>>, store?: KeyValueStore.KeyValueStore) =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const [ref, json] of Object.entries(values)) yield* spill(ref, json)
      return yield* KeyValueStore.KeyValueStore
    }).pipe(
      store === undefined
        ? Effect.provide(KeyValueStore.layerMemory)
        : Effect.provideService(KeyValueStore.KeyValueStore, store)
    )
  )

// A second backend with no shared code with the memory layer: a Map behind makeStringOnly. W6's
// other half, a SQL-backed store, belongs to the bun platform and is tested there.
const mapStore = (): KeyValueStore.KeyValueStore => {
  const held = new Map<string, string>()
  return KeyValueStore.makeStringOnly({
    get: (key) => Effect.succeed(held.get(key)),
    set: (key, value) => Effect.sync(() => void held.set(key, value)),
    remove: (key) => Effect.sync(() => void held.delete(key)),
    clear: Effect.sync(() => held.clear()),
    size: Effect.sync(() => held.size)
  })
}

describe("workspace.read", () => {
  test("a slice never exceeds the cap, whatever length the model asks for", async () => {
    const whole = "x".repeat(DEFAULT_WORKSPACE_POLICY.sliceChars * 2)
    const store = await seeded({ "e1.result": whole })
    const answer = await call(workspacePackage(), "read", { ref: "e1.result", length: 10_000_000 }, store)
    expect((answer.slice as string).length).toBe(DEFAULT_WORKSPACE_POLICY.sliceChars)
    expect(answer.size).toBe(whole.length)
  })

  test("the cap is the consumer's to move", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const answer = await call(workspacePackage({ policy: { sliceChars: 4 } }), "read", { ref: "e1.result" }, store)
    expect(answer.slice).toBe("abcd")
  })

  test("an offset past the end answers with an empty slice and the true size", async () => {
    const store = await seeded({ "e1.result": "0123456789" })
    const answer = await call(workspacePackage(), "read", { ref: "e1.result", offset: 99 }, store)
    expect(answer.slice).toBe("")
    expect(answer.size).toBe(10)
  })

  test("a ref the store never held is an error the model can act on", async () => {
    const store = await seeded({})
    const answer = await call(workspacePackage(), "read", { ref: "nothing.here" }, store)
    expect(String(answer.error)).toContain("nothing.here")
  })
})

describe("workspace.grep", () => {
  test("a match inside a value far larger than one event carries its ref, offset, and context", async () => {
    const needle = "SECRET-PIN-4417"
    const whole = `${"a".repeat(200_000)}${needle}${"b".repeat(200_000)}`
    const store = await seeded({ "e1.noise": "nothing to see", "e2.result": whole })
    const answer = await call(workspacePackage(), "grep", { pattern: needle }, store)
    const matches = answer.matches as ReadonlyArray<{ ref: string; offset: number; context: string }>
    expect(matches).toHaveLength(1)
    expect(matches[0]!.ref).toBe("e2.result")
    expect(matches[0]!.offset).toBe(200_000)
    expect(matches[0]!.context).toContain(needle)
    expect(matches[0]!.context.length).toBe(needle.length + DEFAULT_WORKSPACE_POLICY.contextChars * 2)
    // The offset locates the match for a read, and the read lands on it.
    const slice = await call(workspacePackage(), "read", { ref: "e2.result", offset: matches[0]!.offset, length: needle.length }, store)
    expect(slice.slice).toBe(needle)
  })

  test("a ref narrows the search to one value", async () => {
    const store = await seeded({ a: "find me", b: "find me too" })
    const answer = await call(workspacePackage(), "grep", { pattern: "find me", ref: "b" }, store)
    expect((answer.matches as ReadonlyArray<{ ref: string }>).map((m) => m.ref)).toEqual(["b"])
  })

  test("a match-heavy pattern stops at the bound and says so", async () => {
    const store = await seeded({ a: "hit ".repeat(50) })
    const answer = await call(workspacePackage({ policy: { maxMatches: 3, contextChars: 0 } }), "grep", { pattern: "hit" }, store)
    expect(answer.matches).toHaveLength(3)
    expect(answer.truncated).toBe(true)
  })
})

describe("the sql verb", () => {
  const runner: SqlRunner = { sql: (query, params) => Effect.succeed({ rows: [{ query, params: params.length }] }) }

  test("an unbound workspace has no sql: no method, no doc, no annotation", async () => {
    const pkg = workspacePackage()
    expect(Object.keys(pkg.methods).sort()).toEqual(["grep", "read"])
    expect(pkg.docs?.sql).toBeUndefined()
    expect(pkg.annotations?.sql).toBeUndefined()
    expect(pkg.description).not.toContain("sql")
  })

  test("a bound workspace lists sql and calls the runner", async () => {
    const pkg = workspacePackage({ sql: runner })
    expect(Object.keys(pkg.methods).sort()).toEqual(["grep", "read", "sql"])
    expect(pkg.docs?.sql).toBeDefined()
    const answer = await call(pkg, "sql", { query: "select 1", params: [7] }, await seeded({}))
    expect(answer.rows).toEqual([{ query: "select 1", params: 1 }])
  })

  test("a runner with no doc describes sql in the generic text alone", async () => {
    const pkg = workspacePackage({ sql: runner })
    expect(pkg.docs?.sql?.description).toBe(WORKSPACE_SQL_DESCRIPTION)
  })

  test("a runner's doc is spliced onto the generic text, so the model reads the bound schema", async () => {
    const doc = "notes(id, body) is already here."
    const pkg = workspacePackage({ sql: { ...runner, doc } })
    expect(pkg.docs?.sql?.description).toBe(`${WORKSPACE_SQL_DESCRIPTION} ${doc}`)
  })
})

describe("backend independence", () => {
  test("two unrelated stores answer read and grep identically for the same values", async () => {
    const values = {
      "e1.result": JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, note: "wideé" })) }),
      "e2.result": `${"pad".repeat(20_000)}NEEDLE${"pad".repeat(20_000)}`
    }
    const pkg = workspacePackage()
    const memory = await seeded(values)
    const other = await seeded(values, mapStore())
    for (const args of [{ ref: "e1.result" }, { ref: "e2.result", offset: 59_990, length: 20 }]) {
      expect(await call(pkg, "read", args, other)).toEqual(await call(pkg, "read", args, memory))
    }
    for (const args of [{ pattern: "NEEDLE" }, { pattern: '"note":"wideé"' }]) {
      expect(await call(pkg, "grep", args, other)).toEqual(await call(pkg, "grep", args, memory))
    }
  })
})
