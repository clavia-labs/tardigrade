import type { Envelope } from "@flamecast/core/envelope"

// The code lane's projections: pure functions over the event SET, the TypeScript half of
// tla/Reconcile.tla. Every answer comes from set membership, never event order (the bag law,
// tla/Projection.tla); order survives only as data an event carries. The alphabet these read
// is six events: CodeDispatched, PackageCalled, PackageReturned, BlockedOn, MessageReceived,
// CodeSettled. "Running" is runtime-local to the driver, never derived from the log. "Parked"
// is never a state, only evidence: a `BlockedOn { callId, awaiting }` says one attempt observed
// one reply absent, and the derivation reads it as membership arithmetic (is the awaited id in
// the set now?). The parking call records what it awaits, so no method table exists here.

// ExecFacts is one execution's facts, every field a set-membership question.
export interface ExecFacts {
  readonly execId: string
  // Calls one attempt recorded as blocked, with no recorded pair yet: still open.
  readonly open: ReadonlySet<string>
  // Open calls whose awaited reply is on the lane: harvestable now.
  readonly home: ReadonlySet<string>
  readonly called: boolean
  readonly settled: boolean
}

const str = (v: unknown): string => String(v ?? "")

// factsOf derives in two phases, the sets then the questions, so no answer depends on event
// order.
export const factsOf = (events: ReadonlyArray<Envelope>): ReadonlyArray<ExecFacts> => {
  const dispatched = new Map<string, number>()
  const settled = new Set<string>()
  const awaiting = new Map<string, string>()
  const calls = new Set<string>()
  const returned = new Set<string>()
  const replies = new Set<string>()
  for (const e of events) {
    const v = e as { execId?: unknown; callId?: unknown; id?: unknown; at?: unknown; awaiting?: unknown }
    switch (e.type) {
      case "CodeDispatched": {
        const id = str(v.execId)
        const at = typeof v.at === "number" ? v.at : 0
        dispatched.set(id, Math.min(dispatched.get(id) ?? at, at))
        break
      }
      case "CodeSettled":
        settled.add(str(v.execId))
        break
      case "PackageCalled":
        calls.add(str(v.callId))
        break
      case "BlockedOn":
        awaiting.set(str(v.callId), str(v.awaiting))
        break
      case "PackageReturned":
        returned.add(str(v.callId))
        break
      case "MessageReceived":
        replies.add(str(v.id))
        break
    }
  }
  // A call belongs to the execution whose id prefixes its call id: the
  // executor mints `<execId>.<n>` (`callIdOf`). Ownership from the id,
  // an attribute the event carries, never from log position.
  const execIds = [...dispatched.keys()]
  const ownerOf = (callId: string): string => {
    let owner = ""
    for (const execId of execIds) {
      if (callId.startsWith(`${execId}.`) && execId.length > owner.length) owner = execId
    }
    return owner
  }
  // FIFO by the dispatch's own timestamp, order as carried data. Ties
  // break on the id so the ordering is total and permutation-proof.
  execIds.sort((a, b) => (dispatched.get(a)! - dispatched.get(b)!) || (a < b ? -1 : 1))
  return execIds.map((execId) => {
    const open = new Set<string>()
    const home = new Set<string>()
    let called = false
    for (const callId of calls) {
      if (ownerOf(callId) !== execId) continue
      called = true
      if (!awaiting.has(callId) || returned.has(callId)) continue
      open.add(callId)
      if (replies.has(awaiting.get(callId)!)) home.add(callId)
    }
    return { execId, open, home, called, settled: settled.has(execId) }
  })
}

// canProgress reports whether the execution can move now: fresh (never
// called), a harvest is waiting, or every awaited call is answered and
// the settle is unwritten. Blocked is the only quiet: open calls, none
// answered.
export const canProgress = (f: ExecFacts): boolean =>
  !f.settled && (!f.called || f.home.size > 0 || f.open.size === 0)

// workOwed derives the lane's owed work: the earliest unsettled
// dispatch, when it can progress. Service is serial FIFO: a blocked
// head rests the whole lane (a later body may depend on an earlier
// one's effects).
export const workOwed = (events: ReadonlyArray<Envelope>): ExecFacts | undefined => {
  const head = factsOf(events).find((f) => !f.settled)
  return head !== undefined && canProgress(head) ? head : undefined
}

// restingLane reports quiescence to the platform alarm: no owed work.
// The driver adds its own runtime-local "nothing in flight"; the log's
// half is this.
export const restingLane = (events: ReadonlyArray<Envelope>): boolean => workOwed(events) === undefined
