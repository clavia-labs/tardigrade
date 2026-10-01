import { Context, Deferred, Effect, Schema } from "effect"
import * as fc from "fast-check"
import { act, defineActor, durableAtom, effectAtom, effectKey, RuntimeError, type EffectRef, type Journal, type Recorded, type StoredCheckpoint } from "@clavia/tardigrade-experimental-core"
import { createEventLog } from "@clavia/tardigrade-experimental-core/runtime/replay"
import { createTestStore } from "./store"
import { checkpointDigest, encodeCheckpoint } from "../../../../core/src/services/checkpoint"

const Queued = Schema.Struct({ type: Schema.Literal("Queued"), invocation: Schema.Finite })
const Updated = Schema.Struct({ type: Schema.Literal("Updated"), amount: Schema.Finite })
const Returned = Schema.Struct({ type: Schema.Literal("Returned"), invocation: Schema.Finite })
const Event = Schema.Union([Queued, Updated, Returned])
type Event = typeof Event.Type
const State = Schema.Struct({ invocation: Schema.Finite, pending: Schema.Boolean, updates: Schema.Finite, completed: Schema.Array(Schema.Finite) })
const Job = act({ name: "test.acceptance", input: Schema.Struct({ invocation: Schema.Finite }), success: Schema.Finite, failure: Schema.String })

interface AcceptanceCase {
  readonly invocation: number
  readonly updates: readonly number[]
  readonly checkpoint: boolean
  readonly failCommit: boolean
}

// runAcceptanceScenario checks publication, failed acceptance, and recovery against the real host.
const runAcceptanceScenario = (options: AcceptanceCase) => Effect.runPromise(Effect.gen(function* () {
  const records: Recorded<Event>[] = [{ event: { type: "Queued", invocation: options.invocation } }, ...options.updates.map(amount => ({ event: { type: "Updated" as const, amount } }))]
  const payloads = () => records.map(record => record.event)
  const position = records.length
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  let stored: StoredCheckpoint | undefined
  let blockAcceptance = true
  let failCommit = options.failCommit
  let attempted: EffectRef | undefined
  let request!: ReturnType<typeof Job.request>
  const executions: EffectRef[] = []
  const executionCount = () => executions.length
  const actor = defineActor("acceptance", Effect.sync(() => {
    const state = durableAtom({ name: "test.acceptance", input: Event, schema: State,
      initial: { invocation: 0, pending: false, updates: 0, completed: [] },
      reduce: (state, event) => event.type === "Queued" ? { ...state, invocation: event.invocation, pending: true }
        : event.type === "Updated" ? { ...state, updates: state.updates + event.amount }
        : { ...state, pending: false, completed: [...state.completed, event.invocation] },
    })
    const requests = new Map<number, ReturnType<typeof Job.request>>()
    return { atom: effectAtom(get => {
      const view = get(state)
      if (!view.pending) return { view, events: {}, acts: {} }
      let proposal = requests.get(view.invocation)
      if (!proposal) {
        proposal = Job.request({ tag: "send", input: { invocation: view.invocation },
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
  const append = (expected: number, events: readonly Recorded<Event>[], checkpoint?: StoredCheckpoint) => Effect.gen(function* () {
    const accepted = events.map(record => record.event).find(event => event.type === "EffectRequested")
    if (accepted?.type === "EffectRequested" && blockAcceptance) {
      blockAcceptance = false
      attempted = accepted.ref
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      if (failCommit) return yield* Effect.fail(new RuntimeError("Injected request commit failure"))
    }
    if (expected !== records.length) return yield* Effect.fail(new RuntimeError("Unexpected journal length"))
    records.push(...events)
    if (checkpoint) stored = checkpoint
  })
  const journal: Journal<Event> = {
    read: Effect.sync(() => [...records]),
    readAfter: cursor => Effect.sync(() => {
      if (cursor < 0 || cursor > records.length) throw new RuntimeError("Invalid suffix position")
      return records.slice(cursor)
    }),
    readCheckpoint: Effect.sync(() => stored),
    append, appendWithCheckpoint: append,
  }
  const open = () => createTestStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: () => Context.empty(),
    services: () => Job.layer((input, { ref }) => Effect.sync(() => { executions.push(ref); return input.invocation })),
  })
  const first = yield* open()
  yield* Effect.gen(function* () {
    yield* Deferred.await(entered)
    if (!attempted || attempted.seq !== position || first.get(request.ref) !== undefined || first.snapshot().bindings.size !== 0 || executionCount() !== 0 || payloads().some(event => event.type === "EffectRequested")) return yield* Effect.fail(new RuntimeError("Reference or execution published before request commit"))
    yield* Deferred.succeed(release, undefined)
    const completion = yield* first.wait.pipe(Effect.result)
    if (options.failCommit) {
      if (completion._tag !== "Failure" || first.get(request.ref) !== undefined || executionCount() !== 0 || records.length !== position) return yield* Effect.fail(new RuntimeError("Failed commit published acceptance"))
    } else {
      const published = first.get(request.ref)
      if (completion._tag !== "Success" || !published || effectKey(published) !== effectKey(attempted) || executionCount() !== 1) return yield* Effect.fail(new RuntimeError("Committed request failed to publish acceptance"))
    }
  }).pipe(Effect.ensuring(Effect.gen(function* () {
    failCommit = false
    yield* Deferred.succeed(release, undefined)
    yield* first.close
  })))
  const reopened = yield* open()
  return yield* Effect.gen(function* () {
    yield* reopened.wait
    const accepted = payloads().filter(event => event.type === "EffectRequested")
    if (accepted.length !== 1 || accepted[0]!.type !== "EffectRequested" || accepted[0]!.ref.seq !== position || executions.length !== 1 || effectKey(executions[0]!) !== effectKey(accepted[0]!.ref) || reopened.getState().view.completed.join(",") !== String(options.invocation)) return yield* Effect.fail(new RuntimeError("Recovery changed identity or repeated execution"))
  }).pipe(Effect.ensuring(reopened.close))
}).pipe(Effect.scoped, Effect.timeout(5_000)))

// referenceAcceptanceAtomicity checks references publish with request commits and survive suffix recovery.
export const referenceAcceptanceAtomicity = fc.asyncProperty(fc.record({
  invocation: fc.integer({ min: 1, max: 100 }), updates: fc.array(fc.integer({ min: -10, max: 10 }), { maxLength: 4 }),
  checkpoint: fc.boolean(), failCommit: fc.boolean(),
}), runAcceptanceScenario)
