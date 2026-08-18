import { Clock, Effect } from "effect"
import { EventLog } from "@tardigrade/core/event-log"
import { actor, send, type Actor } from "@tardigrade/core/actor"
import { composeKeys } from "@tardigrade/core/event-log"
import { messageKeys } from "@tardigrade/core/message"
import { codeKeys } from "@tardigrade/code/events"
import { agentKeys } from "./events"
import { codeReactorFor, type CodePolicy } from "@tardigrade/code/execute"
import type { Router } from "@tardigrade/core/router"
import type { Self } from "@tardigrade/core/actor"
import { Infer, inferReactorFor, type InferPolicy } from "./infer"
import { toolsReactorFor } from "./tools"
import { budgetReactorFor, type BudgetPolicy } from "./budget"
import { replyReactor } from "./reply"
import { compactionReactorFor, type ContextPolicy } from "./compaction"
import { codeSurface, type ToolSurface } from "./surface"

export { Infer } from "./infer"

// AgentR is the mind: Infer for the model, EventLog for settle, Router and Self for reply.
// Budget, code, and compaction join at the RLM assembly (rlmAgentFor).
export type AgentR = Infer | EventLog | Router | Self
export type RlmR = AgentR

// agentActorKeys is the mind's key table: its alphabet and the canonical inbound.
export const agentActorKeys = composeKeys(messageKeys, agentKeys)

// rlmActorKeys adds the code lane's fragment. createRlmAgent uses this table.
export const rlmActorKeys = composeKeys(messageKeys, codeKeys, agentKeys)

// AgentPolicy is every policy value an assembled agent applies, one field per reactor that
// applies one, so a caller sets a single number without rebuilding the reactor list. Each field
// is itself partial and fills from its own exported default (infer.ts, budget.ts, compaction.ts,
// packages/code/src/execute.ts). An assembly takes only the fields its reactors apply, so a
// stated policy is never a silently ignored one.
//
// `context` also decides what the model's request renders, and the render happens in the model
// binding, not here. A caller that states one states the same one to `modelRequest`, exactly as
// it does with the surface (compaction.ts, ContextPolicy).
export interface AgentPolicy {
  readonly infer: Partial<InferPolicy>
  readonly budget: Partial<BudgetPolicy>
  readonly context: Partial<ContextPolicy>
  readonly code: Partial<CodePolicy>
}

// agentFor is the mind: infer decides, tools serve the surface, reply reports the terminal home.
// The caller chooses the work half. Code mode is rlmAgentFor(codeSurface()), because execute
// needs the code reactor. The mind applies one policy, the model loop's own ceilings.
export const agentFor = (surface: ToolSurface<AgentR>, policy: Partial<Pick<AgentPolicy, "infer">> = {}) =>
  actor<AgentR>([inferReactorFor(policy.infer), toolsReactorFor(surface), replyReactor], agentActorKeys)

// rlmAgentFor is the Recursive Language Model default: the mind plus budget, durable code, and
// compaction. budget precedes tools, so BudgetExhausted is on the log when the dispatch gate
// reads it. None of the six imports another; they compose through event names.
export const rlmAgentFor = (surface: ToolSurface<RlmR>, policy: Partial<AgentPolicy> = {}) =>
  actor<RlmR>(
    [
      inferReactorFor(policy.infer),
      budgetReactorFor(policy.budget),
      toolsReactorFor(surface),
      codeReactorFor(policy.code),
      replyReactor,
      compactionReactorFor(policy.context)
    ],
    rlmActorKeys
  )

// rlmAgent is that default on code mode. createRlmAgent hosts this actor.
export const rlmAgent = rlmAgentFor(codeSurface())

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
