import { Effect, Schema } from "effect"
import { isDeepStrictEqual } from "node:util"
import type { Journal } from "../services/journal"
import { RuntimeError } from "./effects"
import { AtomState, InitialState, StateInitialised, type StatefulAtom } from "../initialise"
import { ThreadCreated } from "../actor/thread"

// StateInitialisationError identifies invalid destination state supplied by a caller.
export class StateInitialisationError extends RuntimeError {
  static override from(cause: unknown): StateInitialisationError {
    return cause instanceof StateInitialisationError ? cause : new StateInitialisationError(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

// prepareInitialState validates encoded state against destination atom schemas.
export function prepareInitialState(atoms: readonly StatefulAtom[], input: InitialState, source?: Schema.Json): Effect.Effect<StateInitialised, Error> {
  return Effect.gen(function* () {
    const copied = yield* Effect.try({ try: () => structuredClone({ initialState: input, source }), catch: StateInitialisationError.from })
    const state = yield* Schema.decodeEffect(InitialState)(copied.initialState).pipe(Effect.mapError(StateInitialisationError.from))
    yield* Effect.try({ try: () => {
      const codecs = new Map<string, StatefulAtom[typeof AtomState]>()
      for (const atom of atoms) {
        const codec = atom[AtomState]
        if (codecs.has(codec.name)) throw new StateInitialisationError(`Duplicate destination atom: ${codec.name}`)
        codecs.set(codec.name, codec)
      }
      for (const [name, value] of Object.entries(state)) {
        const codec = codecs.get(name)
        if (!codec) throw new StateInitialisationError(`Unknown initial state atom: ${name}`)
        try { codec.decode(value) }
        catch (cause) { throw new StateInitialisationError(`Invalid initial state for atom ${name}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) }
      }
    }, catch: StateInitialisationError.from })
    return yield* Schema.decodeEffect(StateInitialised, { onExcessProperty: "error" })({
      type: "StateInitialised", version: 1,
      initialState: state,
      ...(copied.source === undefined ? {} : { source: copied.source }),
    }).pipe(Effect.mapError(StateInitialisationError.from))
  })
}

// initialiseState validates encoded states before adoption into a fresh journal.
export function initialiseState<Event extends object>(options: {
  readonly journal: Journal<Event>
  readonly atoms: readonly StatefulAtom[]
  readonly initialState: InitialState
  readonly source?: Schema.Json
}): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const event = yield* prepareInitialState(options.atoms, options.initialState, options.source)
    const records = yield* options.journal.read
    const prior = records.map(record => record.event).find(Schema.is(StateInitialised))
    if (prior && isDeepStrictEqual(prior, event)) return
    if (records.length > 1 || records.some(record => !Schema.is(ThreadCreated)(record.event))) return yield* Effect.fail(new RuntimeError("State initialisation requires a fresh journal"))
    yield* options.journal.append(records.length, [{ event }])
  })
}
