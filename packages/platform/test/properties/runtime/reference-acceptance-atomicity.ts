import { journalCall } from "@clavia/tardigrade-core"
import { memoryJournalReads } from "../../fixtures/memory-journal"
import { strict as assert } from "node:assert"
import { Context, Deferred, Effect, Schema } from "effect"
import * as fc from "fast-check"
import { act, defineActor, durableAtom, effectAtom, effectKey, RuntimeError, EffectRef, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-core"
import { createEventLog } from "@clavia/tardigrade-core/runtime/replay"
import { createTestStore } from "./store"
import { checkpointDigest, encodeCheckpoint } from "../../../../core/src/services/checkpoint"

const Queued = Schema.Struct({ type: Schema.Literal("Queued"), invocation: Schema.Finite })
const Updated = Schema.Struct({ type: Schema.Literal("Updated"), amount: Schema.Finite })
const Returned = Schema.Struct({ type: Schema.Literal("Returned"), invocation: Schema.Finite })
const Event = Schema.Union([Queued, Updated, Returned])
type Event = typeof Event.Type
const State = Schema.Struct({ invocation: Schema.Finite, pending: Schema.Boolean, updates: Schema.Finite, completed: Schema.Array(Schema.Finite), origin: Schema.NullOr(EffectRef.fields.seq) })
const Job = act({ name: "test.acceptance", input: Schema.Struct({ invocation: Schema.Finite }), success: Schema.Finite, failure: Schema.String })

interface AcceptanceCase {
  readonly invocation: number
  readonly updates: readonly number[]
  readonly checkpoint: boolean
  readonly failCommit: boolean
  readonly failLookup: boolean
  readonly crashPending: boolean
  readonly forgetSettled: boolean
}

// runAcceptanceScenario checks publication, failed acceptance, and recovery against the real host.
const runAcceptanceScenario = (options: AcceptanceCase) => Effect.runPromise(Effect.gen(function* () {
  const records: Recorded<Event>[] = [{ event: { type: "Queued", invocation: options.invocation } }, ...options.updates.map(amount => ({ event: { type: "Updated" as const, amount } }))]
  const payloads = () => records.map(record => record.event)
  const position = records.length
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const executionEntered = yield* Deferred.make<void>()
  let stored: StoredCheckpoint | undefined
  let blockAcceptance = true
  let failCommit = options.failCommit
  let failLookup = options.failLookup
  let holdExecution = options.crashPending && !options.failCommit
  const lookups: string[] = []
  let attempted: EffectRef | undefined
  let request!: ReturnType<typeof Job.request>
  const executions: EffectRef[] = []
  const executionCount = () => executions.length
  const actor = defineActor("acceptance", Effect.sync(() => {
    const state = durableAtom({ name: "test.acceptance", input: Event, schema: State,
      initial: { invocation: 0, pending: false, updates: 0, completed: [], origin: null },
      reduce: (state, event, _metadata, position) => event.type === "Queued" ? { ...state, invocation: event.invocation, pending: true, origin: position }
        : event.type === "Updated" ? { ...state, updates: state.updates + event.amount }
        : { ...state, pending: false, completed: [...state.completed, event.invocation] },
    })
    const requests = new Map<number, ReturnType<typeof Job.request>>()
    return { atom: effectAtom(get => {
      const view = get(state)
      if (!view.pending && view.origin === null) return { view, events: {}, acts: {} }
      let proposal = requests.get(view.invocation)
      if (!proposal) {
        proposal = Job.request({ origin: view.origin!, input: { invocation: view.invocation },
          onSettled: result => result.status === "fulfilled" ? [{ type: "Returned", invocation: result.value }] : [],
        })
        requests.set(view.invocation, proposal)
      }
      request = proposal
      return { view, events: {}, acts: { send: proposal } }
    }), schema: Event }
  }))
  if (options.checkpoint) {
    const setup = yield* actor.setup
    const log = createEventLog({ schema: Event, atoms: setup.effects })
    try {
      const snapshot = log.replay(records)
      if (snapshot.bindings.size !== 0 || snapshot.effects().some(work => work.ref !== undefined)) return yield* Effect.fail(new RuntimeError("Proposal has a reference before acceptance"))
      const checkpoint = snapshot.checkpoint()
      if (!checkpoint) return yield* Effect.fail(new RuntimeError("Unaccepted work blocks checkpoint capture"))
      const payload = encodeCheckpoint(checkpoint)
      stored = { position, payload, digest: yield* checkpointDigest(payload) }
    } finally {
      log.dispose()
    }
  }
  let awaitingAcceptance = false
  const append = (expected: number, events: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint): undefined => {
    const accepted = events.map(record => record.event).find(event => event.type === "EffectRequested")
    if (accepted?.type === "EffectRequested" && blockAcceptance) {
      blockAcceptance = false
      attempted = accepted.ref
      if (failCommit) { Deferred.doneUnsafe(entered, Effect.void); throw new RuntimeError("Injected request commit failure") }
      awaitingAcceptance = true
    }
    if (expected !== records.length) throw new RuntimeError("Unexpected journal length")
    if (accepted?.type === "EffectRequested" && accepted.origin !== 0) throw new RuntimeError("Acceptance lost its originating request")
    records.push(...events)
    if (checkpoint) stored = checkpoint
  }
  const reads = memoryJournalReads(() => records)
  for (const read of [reads.readBefore, reads.readAfter]) {
    for (const cursor of [-1, 0.5, position + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => read(cursor), RuntimeError, "Memory journal accepted an unavailable boundary")
    }
  }
  if (reads.readBefore(0).length !== 0 || reads.readAfter(position).length !== 0 || reads.readBefore(position).length !== position || reads.readAfter(0).length !== position) throw new RuntimeError("Memory journal changed endpoint semantics")
  const journal: Journal<Event> = {
    ...reads,
    acknowledge: write => journalCall(() => { write?.() }).pipe(Effect.andThen(Effect.suspend(() => {
      if (!awaitingAcceptance) return Effect.void
      awaitingAcceptance = false
      return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
    }))),
    lookupInvocation: identity => {
      if (failLookup) throw new RuntimeError("Injected invocation lookup failure")
      const result = reads.lookupInvocation(identity)
      lookups.push(result.status)
      return result
    },
    readCheckpoint: () => stored,
    append: (position, events) => append(position, events), appendWithCheckpoint: append,
  }
  const open = () => createTestStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(),
    services: runtime => Job.layer((input, { ref }) => Effect.gen(function* () {
      const published = runtime.get(request.ref)
      if (!published || effectKey(published) !== effectKey(ref)) return yield* Effect.die(new RuntimeError("Execution began without its published acceptance binding"))
      executions.push(ref)
      yield* Deferred.succeed(executionEntered, undefined)
      if (holdExecution) return yield* Effect.never
      return input.invocation
    })),
  })
  if (failLookup) {
    const failed = yield* open()
    yield* Effect.gen(function* () {
      const result = yield* failed.wait.pipe(Effect.result)
      if (result._tag !== "Failure" || !String(result.failure).includes("Injected invocation lookup failure") || records.length !== position || executionCount() !== 0 || failed.snapshot().bindings.size !== 0) return yield* Effect.fail(new RuntimeError("Lookup failure admitted or executed work"))
    }).pipe(Effect.ensuring(failed.close))
    failLookup = false
  }
  const first = yield* open()
  yield* Effect.gen(function* () {
    yield* Deferred.await(entered)
    if (!attempted || attempted.seq !== position || first.get(request.ref) !== undefined || first.snapshot().bindings.size !== 0 || executionCount() !== 0 || payloads().filter(event => event.type === "EffectRequested").length !== (options.failCommit ? 0 : 1)) return yield* Effect.fail(new RuntimeError("Reference or execution published before request acknowledgement"))
    yield* Deferred.succeed(release, undefined)
    if (holdExecution) {
      yield* Deferred.await(executionEntered)
      if (executionCount() !== 1 || payloads().filter(event => event.type === "EffectRequested").length !== 1 || payloads().some(event => event.type === "EffectSettled")) return yield* Effect.fail(new RuntimeError("Pending execution did not preserve committed acceptance"))
      return
    }
    const completion = yield* first.wait.pipe(Effect.result)
    if (options.failCommit) {
      if (completion._tag !== "Failure" || first.get(request.ref) !== undefined || executionCount() !== 0 || records.length !== position) return yield* Effect.fail(new RuntimeError("Failed commit published acceptance"))
    } else {
      const published = first.get(request.ref)
      if (completion._tag !== "Success" || published !== undefined || first.snapshot().bindings.size !== 0 || executionCount() !== 1) return yield* Effect.fail(new RuntimeError("Committed request failed to publish acceptance"))
    }
  }).pipe(Effect.ensuring(Effect.gen(function* () {
    failCommit = false
    yield* Deferred.succeed(release, undefined)
    yield* first.close
  })))
  holdExecution = false
  const forgotten = options.forgetSettled && !options.failCommit && !options.crashPending
  if (!options.failCommit && !options.crashPending) {
    const setup = yield* actor.setup
    const log = createEventLog({ schema: Event, atoms: setup.effects })
    try {
      const snapshot = log.replay(records)
      const checkpoint = snapshot.checkpoint()
      if (!checkpoint) return yield* Effect.fail(new RuntimeError("Settled acceptance cannot be checkpointed"))
      const payload = encodeCheckpoint(checkpoint)
      stored = { position: records.length, payload, digest: yield* checkpointDigest(payload) }
    } finally { log.dispose() }
  }
  const reopened = yield* open()
  return yield* Effect.gen(function* () {
    yield* reopened.wait
    const receipt = reopened.get(request.ref)
    if (receipt !== undefined || reopened.snapshot().bindings.size !== 0 || reopened.getState().view.origin !== 0) return yield* Effect.fail(new RuntimeError("Reconstructed request lost its durable receipt"))
    const accepted = payloads().filter(event => event.type === "EffectRequested")
    const expectedExecutions = options.crashPending && !options.failCommit ? 2 : 1
    if (accepted.length !== 1 || accepted[0]!.type !== "EffectRequested" || accepted[0]!.ref.seq !== position || executions.length !== expectedExecutions || executions.some(ref => effectKey(ref) !== effectKey(accepted[0]!.ref)) || reopened.getState().view.completed.join(",") !== String(options.invocation)) return yield* Effect.fail(new RuntimeError("Recovery changed identity or repeated settled execution"))
    if (!lookups.includes("absent") || (expectedExecutions === 2 && !lookups.includes("pending")) || (forgotten && !lookups.includes("settled"))) return yield* Effect.fail(new RuntimeError("Admission bypassed journal lookup"))
    if (forgotten && reopened.recoveryState().status !== "settled") return yield* Effect.fail(new RuntimeError("Skipped settled proposal remained recovery work"))
    if (forgotten) {
      const checked = lookups.filter(status => status === "settled").length
      yield* reopened.send([{ type: "Updated", amount: 0 }])
      yield* reopened.wait
      if (lookups.filter(status => status === "settled").length <= checked || executions.length !== expectedExecutions || payloads().filter(event => event.type === "EffectRequested").length !== 1 || reopened.recoveryState().status !== "settled") return yield* Effect.fail(new RuntimeError("Changed snapshot bypassed journal admission or repeated settled work"))
    }
  }).pipe(Effect.ensuring(reopened.close))
}).pipe(Effect.scoped, Effect.timeout(5_000)))

// referenceAcceptanceAtomicity checks references publish with request commits and survive suffix recovery.
export const referenceAcceptanceAtomicity = fc.asyncProperty(fc.record({
  invocation: fc.integer({ min: 1, max: 100 }), updates: fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 4 }),
  checkpoint: fc.boolean(), failCommit: fc.boolean(), failLookup: fc.boolean(), crashPending: fc.boolean(), forgetSettled: fc.boolean(),
}), runAcceptanceScenario)
