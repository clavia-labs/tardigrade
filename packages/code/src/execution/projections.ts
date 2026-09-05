import type { Event } from "@clavia/tardigrade-core/log/event"
import { codeEventIdentity } from "./events"
import { turnTerminalOf } from "./turns"

// The code thread's projections: pure functions over the event SET, the TypeScript half of
// tla/runtime/Reconcile.tla. Every answer comes from set membership, never event order (the bag law,
// tla/runtime/Projection.tla); order survives only as data an event carries. Provider execution and
// package call ids are unique only inside one model turn, so every fact below is keyed by the
// (turn, id) pair, and an unstamped event keeps its bare id. "Running" is runtime-local to the
// driver, never derived from the log. "Parked" is never a state, only evidence: a `BlockedOn
// { callId, awaiting }` says one attempt observed one response absent, and the derivation reads it
// as membership arithmetic (is the awaited id in the set now?). The parking call records what it
// awaits, so no method table exists here.

// ExecFacts is one execution's facts, every field a set-membership question.
export interface ExecFacts {
  readonly execId: string
  readonly turn?: string
  // Calls one attempt recorded as blocked, with no recorded pair yet: still open.
  readonly open: ReadonlySet<string>
  // Open calls whose awaited reply is on the thread: harvestable now.
  readonly home: ReadonlySet<string>
  readonly called: boolean
  readonly settled: boolean
}

const str = (v: unknown): string => String(v ?? "")

type ScopedExecution = { readonly execId: string; readonly at: number; readonly turn?: string }
type ScopedCall = { readonly callId: string; readonly turn?: string }

// factsOf derives in two phases, the sets then the questions, so no answer depends on event
// order.
export const factsOf = (events: ReadonlyArray<Event>): ReadonlyArray<ExecFacts> => {
  const dispatched = new Map<string, ScopedExecution>()
  const settled = new Set<string>()
  const awaiting = new Map<string, string>()
  const calls = new Map<string, ScopedCall>()
  const returned = new Set<string>()
  const replies = new Set<string>()
  for (const event of events) {
    const value = event as {
      readonly execId?: unknown
      readonly callId?: unknown
      readonly id?: unknown
      readonly at?: unknown
      readonly awaiting?: unknown
      readonly turn?: unknown
    }
    const turn = value.turn === undefined ? undefined : str(value.turn)
    switch (event.type) {
      case "CodeDispatched": {
        const execId = str(value.execId)
        const identity = codeEventIdentity(turn, execId)
        const at = typeof value.at === "number" ? value.at : 0
        const prior = dispatched.get(identity)
        if (prior === undefined || at < prior.at) {
          dispatched.set(identity, { execId, at, ...(turn === undefined ? {} : { turn }) })
        }
        break
      }
      case "CodeSettled":
        settled.add(codeEventIdentity(turn, value.execId))
        break
      case "PackageCalled": {
        const callId = str(value.callId)
        calls.set(codeEventIdentity(turn, callId), { callId, ...(turn === undefined ? {} : { turn }) })
        break
      }
      case "BlockedOn":
        awaiting.set(codeEventIdentity(turn, value.callId), str(value.awaiting))
        break
      case "PackageReturned":
        returned.add(codeEventIdentity(turn, value.callId))
        break
      case "MessageReceived":
      case "ResponseReceived":
        replies.add(str(value.id))
        break
    }
  }
  // A call belongs to the execution in the same turn whose id prefixes its call id: the
  // executor mints `<execId>.<n>` (`callIdOf`). Ownership from the id, an attribute the event
  // carries, never from log position.
  const executions = [...dispatched.entries()]
  const callsByExecution = new Map<string, Array<readonly [string, ScopedCall]>>()
  for (const call of calls) {
    let owner: readonly [string, ScopedExecution] | undefined
    for (const execution of executions) {
      if (
        execution[1].turn === call[1].turn &&
        call[1].callId.startsWith(`${execution[1].execId}.`) &&
        (owner === undefined || execution[1].execId.length > owner[1].execId.length)
      ) owner = execution
    }
    if (owner === undefined) continue
    const owned = callsByExecution.get(owner[0])
    if (owned === undefined) callsByExecution.set(owner[0], [call])
    else owned.push(call)
  }
  // FIFO by the dispatch's own timestamp, order as carried data. Ties break on the identity
  // so the ordering is total and permutation-proof.
  executions.sort(([leftKey, left], [rightKey, right]) =>
    (left.at - right.at) || (leftKey < rightKey ? -1 : 1)
  )
  return executions.map(([identity, execution]) => {
    const open = new Set<string>()
    const home = new Set<string>()
    const ownedCalls = callsByExecution.get(identity) ?? []
    for (const [callIdentity, call] of ownedCalls) {
      if (!awaiting.has(callIdentity) || returned.has(callIdentity)) continue
      open.add(call.callId)
      if (replies.has(awaiting.get(callIdentity)!)) home.add(call.callId)
    }
    const { execId, turn } = execution
    return {
      execId,
      ...(turn === undefined ? {} : { turn }),
      open,
      home,
      called: ownedCalls.length > 0,
      settled: settled.has(identity)
    }
  })
}

// canProgress reports whether the execution can move now: fresh (never called), a harvest is
// waiting, or every awaited call is answered and the settle is unwritten. Blocked is the only
// quiet: open calls, none answered.
export const canProgress = (f: ExecFacts): boolean =>
  !f.settled && (!f.called || f.home.size > 0 || f.open.size === 0)

// workOwed derives the thread's owed work: the earliest unsettled dispatch, when it can
// progress. Service is serial FIFO: a blocked head rests the whole thread (a later body may
// depend on an earlier one's effects).
export const workOwed = (events: ReadonlyArray<Event>): ExecFacts | undefined => {
  const head = factsOf(events).find((f) =>
    !f.settled && (f.turn === undefined || turnTerminalOf(events, f.turn) === undefined)
  )
  return head !== undefined && canProgress(head) ? head : undefined
}

// restingThread reports quiescence to the platform alarm: no owed work. The driver adds its own
// runtime-local "nothing in flight"; the log's half is this.
export const restingThread = (events: ReadonlyArray<Event>): boolean => workOwed(events) === undefined