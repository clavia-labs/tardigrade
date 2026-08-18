import { Clock, Deferred, Effect, Fiber } from "effect"
import { EventLog } from "@tardigrade/core/event-log"
import type { Event } from "@tardigrade/core/event"
import { transition, type Reactor } from "@tardigrade/core/actor"
import { workOwed } from "./projections"
import { annotationsOf, Packages } from "./packages"
import { checkInput, renderSignature } from "./contract"
import { Sandbox, type Bindings } from "./sandbox"
import { turnHead, turnOf } from "./turns"
import { Tmp, TMP_BYTES, tmpPointer } from "./tmp"
import { callId as callIdOf } from "./ids"
import { blockedOn, codeSettled, packageCalled, packageReturned } from "./events"

// The code reactor: durable execution of one body (tla/Reconcile.tla is the model;
// ./projections.ts derives the owed work). An attempt re-runs the body from the top; committed
// PackageCalled/PackageReturned pairs replay without touching the world, and the first
// uncommitted call runs live. A crash between a call's effect and its append re-runs the call:
// at-least-once, like every effect here.
//
// Park is host-internal control flow, never an event. An awaiting call whose reply has not
// landed fails host-side with Park; the body sees a promise that never settles, and once every
// in-flight call has committed or parked, the attempt closes and appends nothing. A reply
// landing at any moment re-raises the owed work (tla/Reconcile.tla, NoVoid); the next attempt
// replays the pairs and harvests what is home.

// CallOutcome is one call's outcome from the proxy's own effect: parked (the body's promise
// never settles) or settled (the body's promise resolves with the result).
type CallOutcome = { readonly parked: true } | { readonly parked: false; readonly result: unknown }

// executeRecorded runs one attempt. The proxy keys each call {execId}.{n} in execution order
// (callId, src/grammar/grammar.ts); a committed answer replays, an uncommitted call runs live
// and records its pair before the body continues. A parked call records no pair: the next
// attempt asks again.
const executeRecorded = (
  execId: string,
  code: string,
  turn?: string,
  dispatchedAt?: number
): Effect.Effect<ReadonlyArray<Event>, never, EventLog | Packages | Sandbox | Tmp> =>
  Effect.gen(function* () {
    const stamp = turn === undefined ? {} : { turn }
    const log = yield* EventLog
    const events = yield* log.read
    // The shadow reading rides the turn's own brief, folded once here: it never changes
    // mid-turn, and every package call below reads the same value.
    const shadow = (turnHead(events) as { shadow?: unknown } | undefined)?.shadow === true
    const packages = yield* Packages
    const sandbox = yield* Sandbox
    const context = yield* Effect.context<Tmp>()
    let n = 0
    // Park bookkeeping. inFlight counts proxy calls from synchronous invoke to committed pair
    // or park; parkGate completes when every open call settled or parked and at least one
    // parked: the cue to stop waiting on the body.
    let inFlight = 0
    let parked = false
    let drifted: string | undefined
    // The calls one attempt observed blocked, with what they await: returned as BlockedOn
    // evidence when the attempt closes, so the derivation reads the awaited ids from the log
    // (no method table; the raiser carries `awaiting` on Park).
    const blocked: Array<{ readonly callId: string; readonly awaiting?: string }> = []
    const parkGate = yield* Deferred.make<void>()
    const bindings: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {}
    for (const card of yield* packages.list()) {
      const pkg = packages.resolve(card.name)
      if (pkg === undefined) continue
      const methods: Record<string, (args: unknown) => Promise<unknown>> = {}
      for (const [method, fn] of Object.entries(pkg.methods)) {
        methods[method] = (args: unknown) => {
          const callId = callIdOf(execId, n++)
          inFlight++
          return Effect.runPromiseWith(context)(
            Effect.gen(function* () {
              const events = yield* log.read
              // The replay guard: a recorded call at this position must be THIS call. Positional
              // ids are sound only for a deterministic body; a drifted body's question must
              // never receive the recorded answer to a different one, so a mismatch dies loud
              // instead (tla/Replay.tla: Trusting fails RightAnswer, Guarded holds it and
              // refusal is drift's only reachable outcome).
              const sent = events.find(
                (e) => e.type === "PackageCalled" && (e as { callId?: unknown }).callId === callId
              ) as { name?: unknown; arguments?: unknown } | undefined
              if (sent !== undefined) {
                const askedName = `${pkg.name}.${method}`
                const drift =
                  String(sent.name) !== askedName
                    ? `asked ${askedName} where the log recorded ${String(sent.name)}`
                    : JSON.stringify(sent.arguments) !== JSON.stringify(args)
                      ? `asked ${askedName} with different arguments than the log recorded`
                      : undefined
                if (drift !== undefined) {
                  // The refusal must be unswallowable: a rejected promise dies in the body's
                  // own catch, so the call halts forever and the attempt is failed from
                  // outside, the park gate's own mechanism.
                  drifted = `nondeterministic body: call ${callId} ${drift}. A body must make the same calls in the same order on every attempt; derive every call from the brief, the input, and recorded returns only.`
                  yield* Deferred.succeed(parkGate, undefined)
                  return yield* Effect.never
                }
              }
              const recorded = events.find(
                (e) => e.type === "PackageReturned" && (e as { callId?: unknown }).callId === callId
              )
              if (recorded) {
                const r = recorded as { result?: unknown; tmp?: unknown }
                inFlight--
                if (r.tmp !== undefined) {
                  const hydrated = yield* (yield* Tmp).load(String(r.tmp))
                  return { parked: false, result: hydrated === undefined ? r.result : JSON.parse(hydrated) }
                }
                return { parked: false, result: r.result }
              }
              // The send commits once. A call already sent but not yet returned (parked on a
              // prior attempt, or mid-flight when a crash lost its outcome) replays as a no-op
              // here: this attempt still asks the method again, because only the method knows
              // whether the answer has landed, but the log never grows a second send for it.
              const alreadySent = events.some(
                (e) => e.type === "PackageCalled" && (e as { callId?: unknown }).callId === callId
              )
              if (!alreadySent) {
                const askedAt = yield* Clock.currentTimeMillis
                yield* log.append([
                  packageCalled({ callId, name: `${pkg.name}.${method}`, arguments: args, ...stamp, at: askedAt })
                ])
              }
              // The shadow rule, over the method's own annotation: a read runs (live reads are
              // the point), a closed-world write runs (owned state; the host substitutes the
              // package's address so it lands on the run's own world facet, docs/worlds.md), and
              // an open-world write is refused before it ever reaches the method body.
              // A method that declares nothing reads as the most dangerous thing it could be, so
              // an unannotated method is refused too, same as `annotationsOf` defaults it. A
              // refusal never parks: it is a host-side answer, not a call to `fn`.
              const annotations = annotationsOf(pkg, method)
              const refused = shadow && !annotations.readOnlyHint && annotations.openWorldHint
              if (refused) {
                const result = { error: `shadow run: ${pkg.name}.${method} is an open-world write and does not execute in a shadow run` }
                const answeredAt = yield* Clock.currentTimeMillis
                yield* log.append([packageReturned({ callId, result, ...stamp, at: answeredAt })])
                inFlight--
                return { parked: false, result }
              }
              // The contract gate: a declared input schema is checked at this funnel, after the
              // shadow rule (isolation outranks teaching: a shadow refusal must stay a shadow
              // refusal whatever the args) and before the method runs. A refusal is a
              // deterministic function of the args and the schema, so replay reproduces it from
              // the recorded pair; the error carries the signature so a wrong call is also the
              // lesson (packages/code/src/contract.ts). A method with no declared input stays
              // unchecked: declaring the schema is what opts a method into the contract.
              const declared = pkg.docs?.[method]?.input
              if (declared !== undefined) {
                const issues = checkInput(args, declared)
                if (issues.length > 0) {
                  const result = {
                    error: `${pkg.name}.${method}: ${issues.join("; ")}. Signature: ${renderSignature(method, declared)}`
                  }
                  const answeredAt = yield* Clock.currentTimeMillis
                  yield* log.append([packageReturned({ callId, result, ...stamp, at: answeredAt })])
                  inFlight--
                  return { parked: false, result }
                }
              }
              // A non-Park failure or defect in the fn is TRANSIENCE (an RPC hiccup, a reset
              // stub), and it takes the park branch: nothing recorded beyond the send, the
              // body's promise never settles, the next attempt asks again. It must never
              // become a rejection the body can catch: a rejection is an input that exists
              // nowhere in the log, so replay would depend on infrastructure luck
              // (execute.test.ts, "transience never reaches the body"; the 2026-08-16
              // run-d7b8b037-183 drift). A method's real failure is an {error} RESULT.
              const parkOut = (awaiting?: string): Effect.Effect<CallOutcome, never, never> =>
                Effect.gen(function* () {
                  parked = true
                  blocked.push({ callId, ...(awaiting === undefined ? {} : { awaiting }) })
                  inFlight--
                  if (inFlight === 0) yield* Deferred.succeed(parkGate, undefined)
                  return { parked: true }
                })
              const attempt = yield* fn(args, { callId }).pipe(
                Effect.map((result): CallOutcome => ({ parked: false, result })),
                Effect.catchTag("Park", (p) => parkOut(p.awaiting)),
                Effect.catch(() => parkOut()),
                Effect.catchDefect(() => parkOut())
              )
              if (attempt.parked) return attempt
              // A large result goes to tmp: the event keeps the pointer, the body still
              // receives the whole value, and replay hydrates the ref.
              const answeredAt = yield* Clock.currentTimeMillis
              const json = JSON.stringify(attempt.result ?? null)
              if (json.length > TMP_BYTES) {
                yield* (yield* Tmp).store(callId, json)
                yield* log.append([
                  packageReturned({ callId, ...tmpPointer(callId, json.length, json.slice(0, 500)), ...stamp, at: answeredAt })
                ])
              } else {
                yield* log.append([packageReturned({ callId, result: attempt.result, ...stamp, at: answeredAt })])
              }
              inFlight--
              return attempt
            }).pipe(Effect.withSpan("package.call", { attributes: { name: `${pkg.name}.${method}`, callId } }))
          ).then((outcome) => (outcome.parked ? new Promise<unknown>(() => {}) : outcome.result))
        }
      }
      bindings[pkg.name] = methods
    }
    // `brief` (the turn's text) and `input` (its structured input) are in scope for every body.
    const head = turnHead(events) as { text?: unknown; input?: unknown } | undefined
    // The body runs as its own fiber: a park interrupts it mid-flight instead of waiting for a
    // promise that, by construction, never settles.
    const fiber = yield* Effect.forkChild(
      sandbox
        .run(
          code,
          { ...bindings, brief: String(head?.text ?? ""), input: head?.input ?? null } as Bindings,
          // The ambient pins the body's clock to the dispatch's own recorded instant and its
          // randomness to the execId: every attempt sees the same values, so a body may read
          // both without drifting (packages/code/src/sandbox.ts, Ambient).
          { at: dispatchedAt ?? 0, seed: execId }
        )
        .pipe(Effect.withSpan("code.run", { attributes: { execId } }))
    )
    // Race the body's own completion against the park gate. Racing only decides who to stop
    // waiting on first; it does not itself interrupt the forked fiber; the `parked` branch below
    // does that explicitly, because `Fiber.join` losing the race only stops this attempt from
    // waiting on it; it does not reach into the body's own fiber.
    yield* Effect.race(Fiber.join(fiber), Deferred.await(parkGate))
    const at = yield* Clock.currentTimeMillis
    // A signaled park wins even over a completed body (a fire-and-forget promise nobody
    // awaited). The attempt closes with no event: the committed calls are the record, and the
    // derivation over them decides rest or go-again. A guest that outlives the interrupt
    // appends keyed, absorbable events.
    if (drifted !== undefined) {
      // The replay guard fired: the body asked a question the log did not record at this
      // position. Loud, never wrong (tla/Replay.tla, RightAnswer).
      yield* Fiber.interrupt(fiber)
      return [codeSettled({ execId, error: drifted, ...stamp, at })]
    }
    if (parked) {
      yield* Fiber.interrupt(fiber)
      // The attempt's blocked calls become evidence: one BlockedOn per awaited call, keyed by
      // the call (bk:, a re-parking attempt absorbs). A transient failure carries no awaited id
      // and records nothing; the alarm re-drives it.
      return blocked
        .filter((b) => b.awaiting !== undefined)
        .map((b) => blockedOn({ callId: b.callId, awaiting: b.awaiting!, ...stamp, at }))
    }
    const outcome = yield* Fiber.join(fiber)
    // Console output rides the settle, capped by the sandbox: the model reads it beside the
    // result, and the trajectory keeps it as evidence. Absent when the body printed nothing.
    const logs = outcome.logs !== undefined && outcome.logs.length > 0 ? { logs: outcome.logs } : {}
    if (outcome.error === undefined) {
      // The settle is what the model will read: a large one goes to tmp and the settle carries
      // the pointer, so no result can nuke the turn context.
      const json = JSON.stringify(outcome.result ?? null)
      if (json.length > TMP_BYTES) {
        const ref = `${execId}.result`
        yield* (yield* Tmp).store(ref, json)
        return [codeSettled({ execId, ...tmpPointer(ref, json.length, json.slice(0, 500)), ...logs, ...stamp, at })]
      }
      return [codeSettled({ execId, result: outcome.result, ...logs, ...stamp, at })]
    }
    return [{ type: "CodeSettled", execId, error: outcome.error, ...logs, ...stamp, at }]
  })

// codeReactor derives the executable head as one transition: the settle is the record
// (`cs:<execId>` through codeKeys), one attempt is the act. `workOwed` is the readiness gate:
// a blocked head (open BlockedOn calls, no awaited reply home) derives nothing, so the lane
// rests honestly and a landing reply re-derives it. An attempt that parks mid-act returns
// BlockedOn evidence instead of the settle; the reconciler reads that as blocked, never wedged.
export const codeReactor: Reactor<Packages | Sandbox | Tmp> = (events) => {
  const owed = workOwed(events)
  if (owed === undefined) return []
  const dispatch = events.find(
    (e) => e.type === "CodeDispatched" && (e as { execId?: unknown }).execId === owed.execId
  )
  if (dispatch === undefined) return []
  const d = dispatch as { code?: unknown; at?: unknown }
  return [
    transition({
      key: `cs:${owed.execId}`,
      input: {
        execId: owed.execId,
        code: String(d.code ?? ""),
        turn: turnOf(dispatch),
        at: typeof d.at === "number" ? d.at : undefined
      },
      act: (input) => executeRecorded(input.execId, input.code, input.turn, input.at)
    })
  ]
}
