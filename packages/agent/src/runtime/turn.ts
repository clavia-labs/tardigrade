import type { ModelLock } from "@clavia/tardigrade-model/lock"
import { Clock, Effect, Schema } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { EventLog } from "@clavia/tardigrade-core/log"
import { send, type ActorSource as Actor } from "@clavia/tardigrade-core/runtime"
import type { Router } from "@clavia/tardigrade-core/transport/router"
import type { Self } from "@clavia/tardigrade-core/runtime"
import type { ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"
import type { InferPolicy } from "../component/infer/contract"
import type { LanguageModel } from "effect/unstable/ai"
import type { OutputContract } from "../output/contract"
import type { BudgetPolicy } from "../component/budget/index"
import type { CompactionPolicy } from "../component/compact/index"
import type { CodePolicy } from "@clavia/tardigrade-code/execution/policy"
import type { WorkspacePolicy } from "@clavia/tardigrade-code/package/workspace"
import { AgentMessageInput } from "../actor/message"


// AgentR lists the agent runtime services; components add their own requirements (core/component.ts, ComponentRequirements).
export type AgentR = ModelLock | LanguageModel.LanguageModel | EventLog | Router | Self | ThreadAllocator | KeyValueStore.KeyValueStore

// AgentPolicy is every policy value an assembled agent applies, one field per part that applies
// one, so a caller sets a single number without listing reactors. Each field is itself partial
// and fills from its own exported default (infer.ts, budget.ts, compaction.ts,
// packages/code/src/execution/policy.ts). `infer` is the root component's policy; `workspace`
// bounds the workspace package's own read and grep answers (packages/code/src/package/workspace.ts); the
// rest ride their components (budget, compaction, codeMode).
export interface AgentPolicy {
  readonly infer: Partial<InferPolicy>
  readonly budget: Partial<BudgetPolicy>
  readonly context: Partial<CompactionPolicy>
  readonly code: Partial<CodePolicy>
  readonly workspace: Partial<WorkspacePolicy>
}

// receive sends the inbound to the given actor. The message id is the dedup key, so delivery can
// be at-least-once.
export const receive = <R, T = unknown>(
  a: Actor<R>,
  // `output` declares the turn's result contract, which outputOf reads as T (src/output/contract.ts, output; src/boundary.ts, outputOf).
  message: AgentMessageInput & {
    readonly id: string
    readonly output?: OutputContract<T>
  }
): Effect.Effect<void, never, EventLog | R> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const events = yield* log.read
    const seen = events.some((e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === message.id)
    if (seen) return
    const input = yield* Schema.decodeUnknownEffect(AgentMessageInput)(message).pipe(Effect.orDie)
    const at = yield* Clock.currentTimeMillis
    yield* send(a, {
      type: "MessageReceived",
      id: message.id,
      ...(input.content === undefined ? { text: input.text } : { content: input.content }),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(message.output === undefined ? {} : { output: { name: message.output.name, schema: message.output.schema } }),
      at
    })
  })
