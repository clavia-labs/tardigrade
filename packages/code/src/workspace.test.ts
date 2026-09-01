import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { DEFAULT_SPILL_POLICY, spill } from "./store"
import { DEFAULT_WORKSPACE_POLICY, WORKSPACE_SQL_DESCRIPTION, workspacePackage, type SqlRunner } from "./workspace"

// The model's view of the store: a bounded slice of one value, a search across all of them, and a
// sql verb only where a platform bound one.

const call = async (pkg: ReturnType<typeof workspacePackage>, method: string, args: unknown) =>
  Effect.runPromise(pkg.methods[method]!(args, { callId: "c1" }) as Effect.Effect<Record<string, unknown>>)

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
    ) as Effect.Effect<KeyValueStore.KeyValueStore>
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
  test("a read respects both the requested-source cap and the serialized-answer cap", async () => {
    const whole = "x".repeat(DEFAULT_WORKSPACE_POLICY.sliceChars * 2)
    const store = await seeded({ "e1.result": whole })
    const answer = await call(workspacePackage(store), "read", { ref: "e1.result", length: 10_000_000 })
    expect((answer.slice as string).length).toBeGreaterThan(0)
    expect((answer.slice as string).length).toBeLessThanOrEqual(DEFAULT_WORKSPACE_POLICY.sliceChars)
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(DEFAULT_WORKSPACE_POLICY.inlineChars)
    expect(answer.size).toBe(whole.length)
  })

  test("the cap is the consumer's to move", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const answer = await call(workspacePackage(store, { policy: { sliceChars: 4 } }), "read", { ref: "e1.result" })
    expect(answer.slice).toBe("abcd")
  })

  test("nextCursor continues at the next unread character without caller arithmetic", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const pkg = workspacePackage(store, { policy: { sliceChars: 4 } })
    const first = await call(pkg, "read", { ref: "e1.result" })
    expect(first).toMatchObject({ ref: "e1.result", offset: 0, length: 4, size: 10, done: false, slice: "abcd" })
    expect(typeof first.nextCursor).toBe("string")

    const second = await call(pkg, "read", { cursor: first.nextCursor })
    expect(second).toMatchObject({ ref: "e1.result", offset: 4, length: 4, size: 10, done: false, slice: "efgh" })

    const last = await call(pkg, "read", { cursor: second.nextCursor })
    expect(last).toEqual({ ref: "e1.result", offset: 8, length: 2, size: 10, done: true, slice: "ij" })
  })

  test("every cursor page fits the shared spill bound and reconstructs the whole value", async () => {
    const whole = JSON.stringify({ rows: Array.from({ length: 2_000 }, (_, i) => ({ i, text: `quoted \\\"value-${i}\\\"` })) })
    const pkg = workspacePackage(await seeded({ "e1.result": whole }))
    let answer = await call(pkg, "read", { ref: "e1.result" })
    let reconstructed = ""
    let pages = 0
    for (;;) {
      expect(JSON.stringify(answer).length).toBeLessThanOrEqual(DEFAULT_SPILL_POLICY.spillBytes)
      reconstructed += String(answer.slice)
      pages++
      if (answer.done === true) break
      answer = await call(pkg, "read", { cursor: answer.nextCursor })
    }
    expect(pages).toBeGreaterThan(1)
    expect(reconstructed).toBe(whole)
  })

  test("a cursor cannot be mixed with random-access arguments", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const pkg = workspacePackage(store, { policy: { sliceChars: 4 } })
    const first = await call(pkg, "read", { ref: "e1.result" })
    const mixed = await call(pkg, "read", { cursor: first.nextCursor, offset: 4 })
    expect(String(mixed.error)).toContain("cursor alone")
  })

  test("an invalid cursor is an error the model can act on", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const answer = await call(workspacePackage(store), "read", { cursor: "not-a-workspace-cursor" })
    expect(answer.error).toBe("invalid workspace.read cursor")
  })

  test("a cap too small for response metadata fails instead of returning an answer that spills", async () => {
    const store = await seeded({ "e1.result": "abcdefghij" })
    const answer = await call(workspacePackage(store, { policy: { inlineChars: 1 } }), "read", { ref: "e1.result" })
    expect(String(answer.error)).toContain("too small")
  })

  test("an offset past the end answers with an empty slice and the true size", async () => {
    const store = await seeded({ "e1.result": "0123456789" })
    const answer = await call(workspacePackage(store), "read", { ref: "e1.result", offset: 99 })
    expect(answer.slice).toBe("")
    expect(answer.size).toBe(10)
    expect(answer.done).toBe(true)
  })

  test("a ref the store never held is an error the model can act on", async () => {
    const store = await seeded({})
    const answer = await call(workspacePackage(store), "read", { ref: "nothing.here" })
    expect(String(answer.error)).toContain("nothing.here")
  })
})

describe("workspace.grep", () => {
  test("a match inside a value far larger than one event carries its ref, offset, and context", async () => {
    const needle = "SECRET-PIN-4417"
    const whole = `${"a".repeat(200_000)}${needle}${"b".repeat(200_000)}`
    const store = await seeded({ "e1.noise": "nothing to see", "e2.result": whole })
    const answer = await call(workspacePackage(store), "grep", { pattern: needle })
    const matches = answer.matches as ReadonlyArray<{ ref: string; offset: number; context: string }>
    expect(matches).toHaveLength(1)
    expect(matches[0]!.ref).toBe("e2.result")
    expect(matches[0]!.offset).toBe(200_000)
    expect(matches[0]!.context).toContain(needle)
    expect(matches[0]!.context.length).toBe(needle.length + DEFAULT_WORKSPACE_POLICY.contextChars * 2)
    // The offset locates the match for a read, and the read lands on it.
    const slice = await call(workspacePackage(store), "read", { ref: "e2.result", offset: matches[0]!.offset, length: needle.length })
    expect(slice.slice).toBe(needle)
  })

  test("a ref narrows the search to one value", async () => {
    const store = await seeded({ a: "find me", b: "find me too" })
    const answer = await call(workspacePackage(store), "grep", { pattern: "find me", ref: "b" })
    expect((answer.matches as ReadonlyArray<{ ref: string }>).map((m) => m.ref)).toEqual(["b"])
  })

  test("a match-heavy pattern stops at the bound and says so", async () => {
    const store = await seeded({ a: "hit ".repeat(50) })
    const answer = await call(workspacePackage(store, { policy: { maxMatches: 3, contextChars: 0 } }), "grep", { pattern: "hit" })
    expect(answer.matches).toHaveLength(3)
    expect(answer.truncated).toBe(true)
  })
})

describe("the sql verb", () => {
  const runner: SqlRunner = { sql: (query, params) => Effect.succeed({ rows: [{ query, params: params.length }] }) }

  test("an unbound workspace has no sql: no method, no doc, no annotation", async () => {
    const pkg = workspacePackage(await seeded({}))
    expect(Object.keys(pkg.methods).sort()).toEqual(["grep", "read"])
    expect(pkg.docs?.sql).toBeUndefined()
    expect(pkg.annotations?.sql).toBeUndefined()
    expect(pkg.description).not.toContain("sql")
  })

  test("a bound workspace lists sql and calls the runner", async () => {
    const pkg = workspacePackage(await seeded({}), { sql: runner })
    expect(Object.keys(pkg.methods).sort()).toEqual(["grep", "read", "sql"])
    expect(pkg.docs?.sql).toBeDefined()
    const answer = await call(pkg, "sql", { query: "select 1", params: [7] })
    expect(answer.rows).toEqual([{ query: "select 1", params: 1 }])
  })

  test("a runner with no doc describes sql in the generic text alone", async () => {
    const pkg = workspacePackage(await seeded({}), { sql: runner })
    expect(pkg.docs?.sql?.description).toBe(WORKSPACE_SQL_DESCRIPTION)
  })

  test("a runner's doc is spliced onto the generic text, so the model reads the bound schema", async () => {
    const doc = "notes(id, body) is already here."
    const pkg = workspacePackage(await seeded({}), { sql: { ...runner, doc } })
    expect(pkg.docs?.sql?.description).toBe(`${WORKSPACE_SQL_DESCRIPTION} ${doc}`)
  })
})

describe("backend independence", () => {
  test("two unrelated stores answer read and grep identically for the same values", async () => {
    const values = {
      "e1.result": JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, note: "wideé" })) }),
      "e2.result": `${"pad".repeat(20_000)}NEEDLE${"pad".repeat(20_000)}`
    }
    const memory = workspacePackage(await seeded(values))
    const other = workspacePackage(await seeded(values, mapStore()))
    for (const args of [{ ref: "e1.result" }, { ref: "e2.result", offset: 59_990, length: 20 }]) {
      expect(await call(other, "read", args)).toEqual(await call(memory, "read", args))
    }
    for (const args of [{ pattern: "NEEDLE" }, { pattern: '"note":"wideé"' }]) {
      expect(await call(other, "grep", args)).toEqual(await call(memory, "grep", args))
    }
  })
})
