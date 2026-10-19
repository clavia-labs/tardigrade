import { expect, test } from "bun:test"
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { ActorReplayError, RuntimeError, actorMethod, createActorStore, defineActor, durableAtom, effectAtom, encodeCheckpoint, event, memoryDocuments, type Journal, type Recorded } from "../src/index"

const Received = event({ type: "Received", value: Schema.String })
type Event = typeof Received.Type
const state = durableAtom({ name: "replay.value", input: Received, schema: Schema.String, initial: "", reduce: (_, event) => event.value })
const actor = defineActor("replay", Effect.succeed({
  atom: effectAtom(get => ({ view: get(state), events: {}, acts: {} })),
  methods: { receive: actorMethod({ inputSchema: Schema.String, outputSchema: Schema.String, onReceive: Received.from(value => ({ value })), result: () => undefined }) },
}))

const journal = (overrides: Partial<Journal<Event>> = {}): Journal<Event> => ({
  storedValues: memoryDocuments(), read: Effect.succeed([]), readAfter: () => Effect.succeed([]), readInputs: Effect.succeed([]),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal.readCheckpoint requires undefined rather than void.
  readCheckpoint: Effect.succeed(undefined),
  append: () => Effect.die("Inspection must not write"), appendWithCheckpoint: () => Effect.die("Inspection must not checkpoint"), ...overrides,
})
const inspect = (history: Journal<Event>) => createActorStore({ actor, journal: history, inspect: true, actorContext: Context.pick(), services: () => Layer.empty })
const failure = async (history: Journal<Event>) => {
  const result = await Effect.runPromise(inspect(history).pipe(Effect.exit))
  if (Exit.isSuccess(result)) { await Effect.runPromise(result.value.close); throw new Error("Expected replay failure") }
  return Cause.squash(result.cause)
}

test("historical decoder failures retain aggregate causes and record positions", async () => {
  const invalid = { type: "Received", value: "valid", model: "synthetic-private-prompt" } as Event
  const records: readonly Recorded<Event>[] = [{ event: { type: "Received", value: "first" } }, { event: invalid }]
  const error = await failure(journal({ read: Effect.succeed(records) }))
  expect(error).toBeInstanceOf(ActorReplayError)
  expect(error).toMatchObject({ code: "actor_replay_failed", stage: "event", reason: "decode_failed", position: 1 })
  if (!(error instanceof ActorReplayError) || !(error.cause instanceof AggregateError)) throw new Error("Expected original aggregate")
  expect(error.cause.errors.some((cause: unknown) => cause instanceof Error && cause.cause instanceof Error && cause.cause.message.includes("model"))).toBe(true)
  expect(ActorReplayError.wrap(error, { stage: "checkpoint", reason: "decode_failed" })).toBe(error)
  expect(RuntimeError.from(error)).toBe(error)
})

test("malformed checkpoints and metadata disagreements have distinct replay reasons", async () => {
  const malformed = await failure(journal({ readCheckpoint: Effect.succeed({ position: 0, digest: "fixture", payload: new TextEncoder().encode("{synthetic-private-checkpoint") }) }))
  expect(malformed).toMatchObject({ stage: "checkpoint", reason: "decode_failed", cause: expect.any(SyntaxError) })
  const mismatch = await failure(journal({ readCheckpoint: Effect.succeed({ position: 1, digest: "fixture", payload: encodeCheckpoint({ position: 0, durable: [], operations: [] }) }) }))
  expect(mismatch).toMatchObject({ stage: "checkpoint", reason: "position_mismatch", position: 1 })
})

test("journal and lazy storage failures keep their original classification", async () => {
  const io = new RuntimeError("storage unavailable")
  for (const history of [journal({ read: Effect.fail(io) }), journal({ readInputs: Effect.fail(io) }), journal({ readCheckpoint: Effect.fail(io) })]) {
    expect(await failure(history)).toBe(io)
  }
  const projected = defineActor("projection", Effect.succeed({ schema: Received, atom: effectAtom(get => {
    const service = get(state)
    if (service === "fail") throw io
    return { view: service, events: {}, acts: {} }
  }) }))
  const result = await Effect.runPromise(createActorStore({ actor: projected, events: [{ type: "Received", value: "fail" }], inspect: true, actorContext: Context.pick(), services: () => Layer.empty }).pipe(Effect.exit))
  expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(io)
})

test("setup and service acquisition failures are not replay failures", async () => {
  const setup = new RuntimeError("setup unavailable")
  const broken = defineActor("setup", Effect.fail(setup))
  const result = await Effect.runPromise(createActorStore({ actor: broken, inspect: true, actorContext: Context.pick(), services: () => Layer.empty }).pipe(Effect.exit))
  expect(Exit.isFailure(result) && Cause.squash(result.cause)).toBe(setup)
  const service = new RuntimeError("service unavailable")
  const serviceResult = await Effect.runPromise(createActorStore({ actor, inspect: true, actorContext: Context.pick(), services: () => Layer.effectDiscard(Effect.fail(service)) }).pipe(Effect.exit))
  expect(Exit.isFailure(serviceResult) && Cause.squash(serviceResult.cause)).toBe(service)
})
