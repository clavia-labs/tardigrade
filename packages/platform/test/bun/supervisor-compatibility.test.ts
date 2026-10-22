import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import { RuntimeError, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { familySupervisorActor, supervisorActor, Provision, pendingThreads, thread, threads, type SupervisorEvent, type ThreadAllocation } from "../../../core/src/services/supervisor/graph"
import { createTestStore } from "../properties/runtime/store"
import { memoryJournalReads } from "../fixtures/memory-journal"

const allocation: ThreadAllocation = { coordinate: { actor: "compat", instance: "main", thread: "one" }, name: "one", parent: null, depth: 0, placement: "independent", initialState: { seed: 42 } }

for (const legacyActor of [false, true]) {
  for (const fails of [false, true]) test(`legacy late registration re-verifies with a fresh origin (${legacyActor ? "directory" : "family"}, ${fails ? "failure" : "success"})`, () => Effect.runPromise(Effect.gen(function* () {
    const records: Recorded<SupervisorEvent>[] = []
    const journal: Journal<SupervisorEvent> = { ...memoryJournalReads(() => records), readCheckpoint: () => undefined,
      append: (position, batch) => { expect(position).toBe(records.length); records.push(...batch) },
      appendWithCheckpoint: () => { throw new RuntimeError("Unexpected checkpoint") },
    }
    let calls = 0
    let fail = true
    const open = () => createTestStore<SupervisorEvent, unknown, never>({
      actor: legacyActor ? supervisorActor : familySupervisorActor, journal, actorContext: Context.pick(),
      services: () => Provision.layer(input => {
        expect(input).toEqual(allocation)
        calls++
        return fail ? Effect.fail("provision failed") : Effect.succeed(null)
      }),
    })
    const first = yield* open()
    yield* Effect.gen(function* () {
      yield* first.send([{ type: "ThreadRequested", allocation }])
      yield* first.wait
      expect(first.get(thread("one"))?.status).toBe("failed")
      const before = JSON.stringify(records)
      for (const type of ["ThreadRegistered", "ThreadFailed"] as const) {
        const result = yield* Effect.exit(first.send([type === "ThreadFailed" ? { type, coordinate: allocation.coordinate, reason: "late" } : { type, coordinate: allocation.coordinate }]))
        expect(result._tag).toBe("Failure")
        expect(JSON.stringify(records)).toBe(before)
      }
    }).pipe(Effect.ensuring(first.close))
    expect(calls).toBe(1)
    const origin = records.length
    records.push({ event: { type: "ThreadRegistered", coordinate: allocation.coordinate } })
    const prefix = JSON.stringify(records)
    fail = fails
    const reopened = yield* open()
    yield* Effect.gen(function* () {
      expect(reopened.get(thread("one"))).toMatchObject({ status: "requested", origin })
      expect(reopened.get(threads)[0]).toMatchObject({ status: "requested", origin })
      expect(reopened.get(pendingThreads)).toEqual(["one"])
      yield* reopened.resume
      yield* reopened.wait
      expect(calls).toBe(2)
      expect(reopened.get(thread("one"))?.status).toBe(fails ? "failed" : "registered")
      expect(reopened.get(pendingThreads)).toEqual([])
      expect(JSON.stringify(records.slice(0, origin + 1))).toBe(prefix)
      if (fails) {
        fail = false
        yield* reopened.send([{ type: "ThreadRequested", allocation }])
        yield* reopened.wait
        expect(calls).toBe(3)
        expect(reopened.get(thread("one"))?.status).toBe("registered")
      }
    }).pipe(Effect.ensuring(reopened.close))
    const settled = yield* open()
    yield* settled.resume.pipe(Effect.andThen(settled.wait), Effect.ensuring(settled.close))
    expect(calls).toBe(fails ? 3 : 2)
  }).pipe(Effect.scoped, Effect.timeout(5_000))))
}

test("legacy replay rejects a late registration for another coordinate", () => Effect.runPromise(Effect.gen(function* () {
  const records: Recorded<SupervisorEvent>[] = [
    { event: { type: "ThreadRequested", allocation } },
    { event: { type: "ThreadFailed", coordinate: allocation.coordinate, reason: "timeout" } },
    { event: { type: "ThreadRegistered", coordinate: { ...allocation.coordinate, instance: "other" } } },
  ]
  const journal: Journal<SupervisorEvent> = { ...memoryJournalReads(() => records), readCheckpoint: () => undefined,
    append: () => { throw new RuntimeError("Unexpected append") }, appendWithCheckpoint: () => { throw new RuntimeError("Unexpected checkpoint") },
  }
  const result = yield* Effect.exit(createTestStore({ actor: familySupervisorActor, journal, actorContext: Context.pick(), services: () => Provision.layer(() => Effect.succeed(null)) }))
  expect(result._tag).toBe("Failure")
}).pipe(Effect.scoped)))
