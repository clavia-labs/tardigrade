import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { factsOf, restingThread, workOwed } from "./projections"

// The isomorphism harness: tla/runtime/Reconcile.tla's theorems, run against the
// real kernel.
//
// Property 1 is the bag law (tla/runtime/Projection.tla): every derivation must
// be invariant under permutation of the event array. This is the test
// the old room fold could never pass, and the whole reason the kernel
// exists.
//
// Property 2 mirrors the spec's actions (Serve/CommitOne/Crash/
// GhostCommit/DeliverReply) as a bounded exhaustive interleaving, and
// asserts NoVoid and QuietIsBlocked on every reachable state, the same
// states TLC walked, now producing real Event arrays for the real
// derivations.

const dispatch = (execId: string): Event => ({ type: "CodeDispatched", execId, at: Number(execId.replace(/\D/g, "") || 0) } as Event)
const call = (callId: string, awaits: boolean): Event =>
  ({ type: "PackageCalled", callId, name: awaits ? "agents.run" : "notes.commit" } as Event)
// The awaited-ness of a call is now evidence the attempt records: BlockedOn carries the reply
// id the call awaits (no method table, packages/code/src/execution/projections.ts).
const blocked = (callId: string): Event =>
  ({ type: "BlockedOn", callId, awaiting: `${callId}.reply` } as Event)
const pair = (callId: string): Event => ({ type: "PackageReturned", callId } as Event)
const reply = (callId: string): Event => ({ type: "MessageReceived", id: `${callId}.reply` } as Event)
const settle = (execId: string): Event => ({ type: "CodeSettled", execId } as Event)

describe("the bag law: derivations are permutation-invariant", () => {
  // Histories assembled from a small vocabulary, then shuffled. The
  // generator does not enforce causal order: the bag law must hold for
  // garbage too (a zombie's append does not wait for causality).
  const vocabulary: ReadonlyArray<Event> = [
    dispatch("e1"),
    dispatch("e2"),
    call("e1.0", true),
    call("e1.1", false),
    call("e1.2", true),
    call("e2.0", true),
    blocked("e1.0"),
    blocked("e1.2"),
    blocked("e2.0"),
    pair("e1.0"),
    pair("e1.1"),
    pair("e2.0"),
    reply("e1.0"),
    reply("e1.2"),
    reply("e2.0"),
    settle("e1"),
    settle("e2")
  ]

  const snapshot = (events: ReadonlyArray<Event>): string =>
    JSON.stringify({
      facts: factsOf(events).map((f) => ({
        execId: f.execId,
        open: [...f.open].sort(),
        home: [...f.home].sort(),
        called: f.called,
        settled: f.settled
      })),
      owed: workOwed(events)?.execId ?? null,
      resting: restingThread(events)
    })

  test("any subset, any order: same facts, same owed work, same rest", () => {
    fc.assert(
      fc.property(
        fc.subarray([...vocabulary]),
        fc.infiniteStream(fc.nat()),
        (subset, seeds) => {
          const shuffled = [...subset]
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = seeds.next().value % (i + 1)
            ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
          }
          expect(snapshot(shuffled)).toBe(snapshot(subset))
        }
      ),
      { numRuns: 500 }
    )
  })
})

test("a code dispatch appended after cancellation is inert", () => {
  const events: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "m1", text: "work", at: 1 },
    { type: "TurnCancelled", request: "x1", turn: "m1", cause: "requested", at: 2 },
    { type: "CodeDispatched", execId: "late", code: "write()", turn: "m1", at: 3 }
  ]
  expect(workOwed(events)).toBeUndefined()
  expect(restingThread(events)).toBe(true)
})

describe("the spec's state graph: NoVoid and QuietIsBlocked on every reachable state", () => {
  // The TLA model, executable: one dispatch "d", calls CALLS, an attempt
  // planned from a snapshot, commits one at a time (terminal last), a
  // crash that leaves a ghost, replies delivering any time. Bounded
  // exhaustive exploration, invariants checked at every state.
  const CALLS = ["d.0", "d.1"]
  const MAX_CRASHES = 1

  interface S {
    readonly events: ReadonlyArray<Event>
    readonly pending: ReadonlyArray<Event>
    readonly ghosts: ReadonlyArray<Event>
    readonly crashes: number
  }

  const has = (s: S, type: string, key: "execId" | "callId" | "id", value: string): boolean =>
    s.events.some((e) => e.type === type && (e as Record<string, unknown>)[key] === value)

  // The plan, from the snapshot: uncalled calls, returns for answers
  // home, the settle when everything is closed. Terminal last is the
  // writer's one ordering obligation: commits pull non-settle first.
  const plan = (s: S): ReadonlyArray<Event> => {
    const facts = factsOf(s.events).find((f) => f.execId === "d")
    if (facts === undefined || facts.settled) return []
    const out: Event[] = []
    for (const c of CALLS)
      if (!s.events.some((e) => e.type === "PackageCalled" && (e as { callId?: unknown }).callId === c)) {
        // The attempt records the send and, on parking, its BlockedOn evidence: both ride the
        // same close, so the plan pairs them.
        out.push(call(c, true), blocked(c))
      }
    for (const c of facts.home) out.push(pair(c))
    const uncalled = CALLS.some((c) => !s.events.some((e) => e.type === "PackageCalled" && (e as { callId?: unknown }).callId === c))
    const openAfter = [...facts.open].filter((c) => !facts.home.has(c))
    if (!uncalled && openAfter.length === 0) out.push(settle("d"))
    return out
  }

  const successors = (s: S): ReadonlyArray<S> => {
    const out: S[] = []
    // Serve: work owed, nothing in flight.
    if (s.pending.length === 0 && workOwed(s.events) !== undefined) {
      const p = plan(s)
      if (p.length > 0) out.push({ ...s, pending: p })
    }
    // CommitOne: terminal last.
    const committable = s.pending.filter((e) => e.type !== "CodeSettled" || s.pending.length === 1)
    for (const e of committable) {
      out.push({ ...s, events: [...s.events, e], pending: s.pending.filter((x) => x !== e) })
    }
    // Crash: the remainder becomes a ghost.
    if (s.pending.length > 0 && s.crashes < MAX_CRASHES) {
      out.push({ ...s, ghosts: [...s.ghosts, ...s.pending], pending: [], crashes: s.crashes + 1 })
    }
    // GhostCommit: terminal last, interleaves with anything.
    const ghostable = s.ghosts.filter((e) => e.type !== "CodeSettled" || s.ghosts.length === 1)
    for (const e of ghostable) {
      out.push({ ...s, events: [...s.events, e], ghosts: s.ghosts.filter((x) => x !== e) })
    }
    // DeliverReply: any called, unanswered call, any time.
    for (const c of CALLS) {
      if (has(s, "PackageCalled", "callId", c) && !has(s, "MessageReceived", "id", `${c}.reply`)) {
        out.push({ ...s, events: [...s.events, reply(c)] })
      }
    }
    return out
  }

  test("bounded exhaustive: both invariants hold everywhere", () => {
    const init: S = { events: [dispatch("d")], pending: [], ghosts: [], crashes: 0 }
    const seen = new Set<string>()
    const keyOf = (s: S): string =>
      JSON.stringify([
        s.events.map((e) => JSON.stringify(e)).sort(),
        s.pending.map((e) => JSON.stringify(e)).sort(),
        s.ghosts.map((e) => JSON.stringify(e)).sort(),
        s.crashes
      ])
    let frontier: S[] = [init]
    let states = 0
    while (frontier.length > 0) {
      const next: S[] = []
      for (const s of frontier) {
        const k = keyOf(s)
        if (seen.has(k)) continue
        seen.add(k)
        states++
        const facts = factsOf(s.events).find((f) => f.execId === "d")!
        // NoVoid: an answer home with no attempt in flight is owed work.
        if (facts.home.size > 0 && s.pending.length === 0 && !facts.settled) {
          expect(workOwed(s.events)?.execId).toBe("d")
        }
        // QuietIsBlocked: quiet, unsettled, no ghosts pending: then the
        // thread is genuinely waiting on the world.
        if (restingThread(s.events) && s.pending.length === 0 && s.ghosts.length === 0 && !facts.settled) {
          expect(facts.open.size).toBeGreaterThan(0)
          expect(facts.home.size).toBe(0)
        }
        next.push(...successors(s))
      }
      frontier = next
    }
    expect(states).toBeGreaterThan(100)
  })
})
