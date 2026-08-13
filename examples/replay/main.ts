import { Effect, Layer } from "effect"
import type { Envelope } from "@flamecast/core"
import { inferWith, keyOf, type TurnResult } from "@flamecast/harness"
import { MemoryRuntime } from "@flamecast/runtime-memory"
import { supportAgent } from "../support-agent/agent"
import { stubModel } from "../support-agent/model"

// The central claim, run end to end.
//
//   bun run examples/replay/main.ts
//
// A turn is recorded. The recorded log is then replayed in a second store, against a model that
// throws the moment it is called. The same answer comes back, nothing is appended, the recording
// is untouched, and the model is never reached, because every act committed its outcome and replay
// is re-folding.

const session = "replay-demo"
const question = "Find the invoice for order 4182."

const modelCalls = (log: ReadonlyArray<Envelope>): number =>
  log.filter((event) => event.type === "ModelCalled").length

const answerIn = (log: ReadonlyArray<Envelope>): string =>
  String(log.find((event) => event.type === "TurnCompleted")?.output ?? "(none)")

// The model that must never run. A replay that reached it would fail loudly here rather than
// quietly cost money, which is the assertion this example exists to make.
let reached = 0
const refuses = inferWith(async () => {
  reached += 1
  throw new Error("the model was called during a replay: the record already held the answer")
})

// Two stores, built as two layer values. The recording lives in the first and the replay runs
// against the second, so the replay can not read the first one's answers by accident.
const recording = MemoryRuntime({ session, keyOf })
const replaying = MemoryRuntime({ session, keyOf })

// Step 1. Run the turn for real and keep its log.
const recorded = await Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const result = yield* supportAgent.turn({ id: "m-1", text: question })
      return { result, log: yield* supportAgent.log }
    }),
    Layer.merge(recording, stubModel)
  )
)

// Step 2. Replay that log in the second store, against the refusing model.
const replayed = await Effect.runPromise(
  Effect.provide(
    Effect.gen(function* () {
      const result = yield* supportAgent.replay(recorded.log)
      return { result, log: yield* supportAgent.log }
    }),
    Layer.merge(replaying, refuses)
  )
)

// The recording must be untouched by the replay: the replay ran against a different store
// entirely. The same layer value serves one store, so reading it again reads what step 1 left.
const after = await Effect.runPromise(
  Effect.provide(supportAgent.log, Layer.merge(recording, stubModel))
)

// The turn's outcome is a discriminated union, so the answer is read off `kind` and a turn that
// did not complete reports what it did instead.
const outputOf = (result: TurnResult): string =>
  result.kind === "completed" ? result.output : `(${result.kind})`

const rows: ReadonlyArray<readonly [string, string, string]> = [
  ["", "recorded run", "replay"],
  ["answer", answerIn(recorded.log), answerIn(replayed.log)],
  ["reported output", outputOf(recorded.result), outputOf(replayed.result)],
  ["model calls", String(modelCalls(recorded.log)), String(reached)],
  ["events", String(recorded.log.length), String(replayed.log.length)],
  ["cost", `$${recorded.result.usage.costUsd.toFixed(4)}`, `$${replayed.result.usage.costUsd.toFixed(4)}`]
]

// The middle column is as wide as its widest value, so an answer of any length still lines up.
const width = Math.max(...rows.map(([, left]) => left.length)) + 2

console.log("\nreplay: the property that makes evolution possible\n")
console.log(`  session    ${session}`)
console.log(`  question   ${question}\n`)

for (const [label, left, right] of rows) {
  console.log(`  ${label.padEnd(18)}${left.padEnd(width)}${right}`)
  if (label === "") console.log(`  ${"".padEnd(18)}${"-".repeat(left.length).padEnd(width)}------`)
}

const appended = replayed.log.length - recorded.log.length
const identical = JSON.stringify(recorded.log) === JSON.stringify(replayed.log)

console.log("")
console.log(`  events appended by the replay:  ${appended}`)
console.log(`  logs are identical:             ${identical ? "yes" : "NO"}`)
console.log(`  the recording after the replay: ${after.length} events (was ${recorded.log.length})`)

const proved =
  reached === 0 &&
  appended === 0 &&
  identical &&
  after.length === recorded.log.length &&
  answerIn(recorded.log) === answerIn(replayed.log)

console.log(
  proved
    ? "\n  PROVED: the same answer came back with no model call and nothing appended.\n"
    : "\n  FAILED: replay did not reproduce the recorded run.\n"
)

if (!proved) process.exit(1)

console.log(
  "  Replay is re-folding. Events are immutable, every fold is pure, and every act committed its"
)
console.log(
  "  outcome, so a second pass reads the recorded result instead of repeating it. That is what"
)
console.log(
  "  lets an optimizer score a changed harness against thousands of stored runs for free.\n"
)
