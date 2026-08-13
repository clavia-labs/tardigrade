import { Effect, Layer } from "effect"
import { keyOf, undeclaredEvents } from "@flamecast/harness"
import { MemoryRuntime } from "@flamecast/runtime-memory"
import { supportAgent } from "./agent"
import { modelBinding } from "./model"

// The documented agent, running.
//
//   bun run examples/support-agent/main.ts
//   bun run examples/support-agent/main.ts "What is the total on order 4190?"
//
// It needs no API key and reaches no network. Set MODEL_API_KEY to swap the stub for a real
// provider; nothing else in this file changes.

const session = "user-42"
const question = process.argv.slice(2).join(" ") || "Find the invoice for order 4182."

const model = modelBinding()

// One layer binds every port a turn needs. `keyOf` is the dedup policy for the harness alphabet,
// and the runtime requires it: with it, a redelivered message opens no second turn.
const runtime = Layer.merge(MemoryRuntime({ session, keyOf }), model.layer)

const program = Effect.gen(function* () {
  const result = yield* supportAgent.turn({ id: "m-1", text: question })
  const log = yield* supportAgent.log
  return { result, log }
})

const { result, log } = await Effect.runPromise(Effect.provide(program, runtime))

const line = (label: string, value: string) => console.log(`  ${label.padEnd(11)}${value}`)

console.log("\nsupport-agent: the documented agent, running\n")
line("model", model.label)
line("program", supportAgent.program.id)
line("session", session)
console.log("")
line("question", question)
// The outcome is a discriminated union, so the three endings are read from `kind` rather than from
// which field happens to be absent.
line(
  "answer",
  result.kind === "completed"
    ? result.output
    : result.kind === "failed"
      ? `(failed: ${result.error})`
      : result.kind === "parked"
        ? `(parked on a budget ask: ${result.reason})`
        : "(the turn is still open)"
)
line(
  "usage",
  `${result.usage.promptTokens} in / ${result.usage.completionTokens} out / $${result.usage.costUsd.toFixed(4)}`
)

console.log(`\n  log (${log.length} events)`)
for (const [index, event] of log.entries()) {
  console.log(`    ${String(index + 1).padStart(2)}  ${event.type}`)
}

// `Module.events` is a declared alphabet, and this is the check that keeps it honest: every event
// type the run produced has to be owned by one of the modules the agent was built from. An
// exporter reads the same list to know which rows it owes a mapping.
const undeclared = undeclaredEvents(supportAgent.program, log)
console.log(
  `\n  declared alphabet: ${supportAgent.program.events.length} event types, ` +
    (undeclared.length === 0
      ? "and the run emitted nothing outside it"
      : `and the run emitted ${undeclared.join(", ")} outside it`)
)
console.log("")
