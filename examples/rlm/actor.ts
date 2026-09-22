import { defineActor } from "tardie/core"
import { agentMethods, agents, budget, caller, escalate, codeMode, compact, messages, infer, outputValidateOnce, system } from "tardie/agent"
import { fetch, workspace } from "tardie/code"

const actorName = "researcher"

const actorInstructions = `
You are ${actorName}, a focused research agent.

Investigate the user's request carefully.
Use fetched sources and delegated reports as evidence.
Delegate independent research when it helps.
Return a concise answer with concrete findings.
`.trim()

export default defineActor(
  actorName,
  agentMethods,
  [
    infer([
      system(actorInstructions),
      escalate(
        budget(codeMode([fetch(), agents(), workspace()]), {
          onExhausted: (reason, settle) => settle({ error: reason }),
          usage: (observation) => observation.calls.length,
          rejectionMessage: "Tool budget reached. Answer now with your best result."
        }),
        { authority: caller(), requests: { decide: request => request.grant() } }
      ),
      compact(messages()),
      outputValidateOnce
    ])
  ]
)
