import {
  actor, agentMethods, agentsPackage, budget, budgetAuthority, caller, codeMode,
  compaction, fetchPackage, infer,
  outputValidateOnce, system, workspacePackage
} from "tardie"

const actorName = "researcher"

const actorInstructions = `
You are ${actorName}, a focused research agent.

Investigate the user's request carefully.
Use project files as evidence.
Delegate independent research when it helps.
Return a concise answer with concrete findings.
`.trim()

export default actor({
  name: actorName,
  methods: agentMethods,
  components: [
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
})
