import { Clock, Effect } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { EventLog } from "@clavia/tardigrade-core/event-log"
import { send, type Actor } from "@clavia/tardigrade-core/actor"
import type { Transport } from "@clavia/tardigrade-core/communication/transport"
import type { Self } from "@clavia/tardigrade-core/actor"
import type { Facets } from "@clavia/tardigrade-core/facets"
import type { Infer, InferPolicy } from "./runtime/infer"
import type { OutputContract } from "./output"
import type { BudgetPolicy } from "./components/budget"
import type { ContextPolicy } from "./components/compaction"
import type { CodePolicy } from "@clavia/tardigrade-code/execute"
import type { WorkspacePolicy } from "@clavia/tardigrade-code/workspace"

export { Infer } from "./runtime/infer"

// AgentR is the infer root's needs: Infer for the model, EventLog for settle, Transport, Self, and
// Facets for reply and spawn (the deliver, identity, and observe privileges; core/facets.ts), and
// KeyValueStore for the spill store code mode writes bounded results to
// (packages/code/src/spill.ts). Components add their own on top (core/component.ts,
// ComponentRequirements).
export type AgentR = Infer | EventLog | Transport | Self | Facets | KeyValueStore.KeyValueStore
export type RlmR = AgentR

// AgentPolicy is every policy value an assembled agent applies, one field per part that applies
// one, so a caller sets a single number without listing reactors. Each field is itself partial
// and fills from its own exported default (infer.ts, budget.ts, compaction.ts,
// packages/code/src/execute.ts). `infer` is the root component's policy; `workspace`
// bounds the workspace package's own read and grep answers (packages/code/src/workspace.ts); the
// rest ride their components (budgetFor, compactionFor, codeMode).
export interface AgentPolicy {
  readonly infer: Partial<InferPolicy>
  readonly budget: Partial<BudgetPolicy>
  readonly context: Partial<ContextPolicy>
  readonly code: Partial<CodePolicy>
  readonly workspace: Partial<WorkspacePolicy>
}

// receive sends the inbound to the given actor. The message id is the dedup key, so delivery can
// be at-least-once.
export const receive = <R, T = unknown>(
  a: Actor<R>,
  // `output` declares the turn's result contract, which outputOf reads as T (src/output.ts, output; src/boundary.ts, outputOf).
  message: {
    readonly id: string
    readonly text: string
    readonly input?: unknown
    readonly output?: OutputContract<T>
  }
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
      ...(message.output === undefined ? {} : { output: { name: message.output.name, schema: message.output.schema } }),
      at
    })
  })
