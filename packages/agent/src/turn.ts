import { Clock, Effect } from "effect"
import { EventLog } from "@tardigrade/core/event-log"
import { actor, send, type Actor } from "@tardigrade/core/actor"
import { composeKeys } from "@tardigrade/core/event-log"
import { messageKeys } from "@tardigrade/core/message"
import { codeKeys } from "@tardigrade/code/events"
import { agentKeys } from "./events"
import { codeReactor } from "@tardigrade/code/execute"
import type { Router } from "@tardigrade/core/router"
import type { Self } from "@tardigrade/core/actor"
import { Infer, inferReactor } from "./infer"
import { toolsReactorFor } from "./tools"
import { budgetReactor } from "./budget"
import { replyReactor } from "./reply"
import { compactionReactor } from "./compaction"
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

// agentFor is the mind: infer decides, tools serve the surface, reply reports the terminal home.
// The caller chooses the work half. Code mode is rlmAgentFor(codeSurface()), because execute
// needs the code reactor.
export const agentFor = (surface: ToolSurface<AgentR>) =>
  actor<AgentR>([inferReactor, toolsReactorFor(surface), replyReactor], agentActorKeys)

// rlmAgentFor is the Recursive Language Model default: the mind plus budget, durable code, and
// compaction. budget precedes tools, so BudgetExhausted is on the log when the dispatch gate
// reads it. None of the six imports another; they compose through event names.
export const rlmAgentFor = (surface: ToolSurface<RlmR>) =>
  actor<RlmR>(
    [inferReactor, budgetReactor, toolsReactorFor(surface), codeReactor, replyReactor, compactionReactor],
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
