import { Effect } from "effect"
import { createEventLog } from "tardie/core"
import { counter } from "./counter"

export const runCounter = () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const setup = yield* counter.setup
  const log = createEventLog({ schema: setup.schema, atoms: setup.effects })
  try {
    const snapshot = log.append(log.initial, { type: "Incremented" })
    return snapshot.get(setup.root)
  } finally {
    log.dispose()
  }
})))
