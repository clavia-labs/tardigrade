import { Clock, Effect } from "effect"
import { EventLog } from "@flamecast/core/event-log"
import { actor, send } from "@flamecast/core/actor"
import { composeKeys } from "@flamecast/core/event-log"
import { messageKeys } from "@flamecast/core/message"
import { codeKeys } from "@flamecast/code/events"
import { agentKeys } from "./events"
import { codeReactor } from "@flamecast/code/execute"
import type { Tmp } from "@flamecast/code/tmp"
import type { Packages } from "@flamecast/code/packages"
import type { Sandbox } from "@flamecast/code/sandbox"
import type { Router } from "@flamecast/core/router"
import type { Self } from "@flamecast/core/actor"
import { Infer, inferReactor } from "./infer"
import { toolsReactorFor } from "./tools"
import { budgetReactor } from "./budget"
import { replyReactor } from "./reply"
import { compactionReactor } from "./compaction"
import { codeSurface, type ToolSurface } from "./surface"

export { Infer } from "./infer"

// agent is one actor, six reactors over one log. infer decides, budget fires the wall, tools
// serves the surface's tools, code runs bodies durably, reply reports the terminal home,
// compaction checkpoints the context. None imports another; they compose through event names.
// budget precedes tools in the list, so BudgetExhausted is on the log when the dispatch gate
// reads it.
export type AgentR = Infer | EventLog | Packages | Sandbox | Tmp | Router | Self
// agentActorKeys is the agent's own key table: its alphabet, the code lane's, and the canonical
// inbound. A platform composes wider (its app fragments join in) when it builds its own actor;
// this default serves the library tier and tests.
export const agentActorKeys = composeKeys(messageKeys, codeKeys, agentKeys)

// agentFor composes the actor around one tool surface. The code lane stays in the list whatever
// the surface is: it derives work only from `CodeDispatched`, so a surface that never dispatches
// code leaves it quiet.
export const agentFor = (surface: ToolSurface<AgentR>) =>
  actor<AgentR>(
    [inferReactor, budgetReactor, toolsReactorFor(surface), codeReactor, replyReactor, compactionReactor],
    agentActorKeys
  )

// agent is the default assembly: code mode, the surface this library prefers.
export const agent = agentFor(codeSurface())

// receive sends the inbound to the actor. The message id is the dedup key, so delivery can be
// at-least-once.
export const receive = (
  // `output` is the turn's contract: a message that declares one is answered in that shape,
  // whichever door it arrived through.
  message: { readonly id: string; readonly text: string; readonly input?: unknown; readonly output?: unknown }
): Effect.Effect<void, never, AgentR> =>
  Effect.gen(function* () {
    const log = yield* EventLog
    const events = yield* log.read
    const seen = events.some((e) => e.type === "MessageReceived" && (e as { id?: unknown }).id === message.id)
    if (seen) return
    const at = yield* Clock.currentTimeMillis
    yield* send(agent, {
      type: "MessageReceived",
      id: message.id,
      text: message.text,
      ...(message.input === undefined ? {} : { input: message.input }),
      ...(message.output === undefined ? {} : { output: message.output }),
      at
    })
  })
