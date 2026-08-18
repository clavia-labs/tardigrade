import { Clock, Effect } from "effect"
import { EventLog } from "@tardigrade/core/event-log"
import { send, type Actor } from "@tardigrade/core/actor"
import type { Router } from "@tardigrade/core/router"
import type { Self } from "@tardigrade/core/actor"
import type { Infer, InferPolicy } from "./infer"
import type { BudgetPolicy } from "./budget"
import type { ContextPolicy } from "./compaction"
import type { CodePolicy } from "@tardigrade/code/execute"

export { Infer } from "./infer"

// AgentR is the runtime's needs: Infer for the model, EventLog for settle, Router and Self for
// reply. Capabilities add their own on top (capability.ts, RequirementsOf).
export type AgentR = Infer | EventLog | Router | Self
export type RlmR = AgentR

// AgentPolicy is every policy value an assembled agent applies, one field per part that applies
// one, so a caller sets a single number without listing reactors. Each field is itself partial
// and fills from its own exported default (infer.ts, budget.ts, compaction.ts,
// packages/code/src/execute.ts). `infer` is the runtime's policy (actorOf takes it); the rest
// ride their capabilities (budgetFor, compactionFor, codeModeFor).
export interface AgentPolicy {
  readonly infer: Partial<InferPolicy>
  readonly budget: Partial<BudgetPolicy>
  readonly context: Partial<ContextPolicy>
  readonly code: Partial<CodePolicy>
}

// receive sends the inbound to the given actor. The message id is the dedup key, so delivery can
// be at-least-once.
export const receive = <R>(
  a: Actor<R>,
  // `output` is the turn's contract: a message that declares one is answered in that shape,
  // whichever door it arrived through.
  message: { readonly id: string; readonly text: string; readonly input?: unknown; readonly output?: unknown }
): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const events = yield* log.read
    const seen = events.some((e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === message.id)
    if (seen) return
    const at = yield* Clock.currentTimeMillis
    yield* send(a, {
      type: "MessageReceived",
      id: message.id,
      text: message.text,
      ...(message.input === undefined ? {} : { input: message.input }),
      ...(message.output === undefined ? {} : { output: message.output }),
      at
    })
  })
