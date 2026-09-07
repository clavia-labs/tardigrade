import { defineActor } from "tardie/core"
import { agentMethods, agentsPackage, budget, budgetAuthority, caller, codeMode, compaction, infer, outputValidateOnce, system } from "tardie/agent"
import { fetchPackage, workspacePackage } from "tardie/code"

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
      budget([
        codeMode([
          fetchPackage(), agentsPackage(), workspacePackage()
        ])
      ], { authority: caller() }),
      compaction(),
      outputValidateOnce
    ]),
    budgetAuthority()
  ]
)
