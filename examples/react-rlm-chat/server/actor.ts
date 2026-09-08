import { actor } from "tardie/core"
import { agentMethods, agentsPackage, budget, budgetAuthority, caller, codeMode, compaction, infer, outputValidateOnce, system } from "tardie/agent"
import { fetchPackage, workspacePackage } from "tardie/code"

const actorName = "react-chat"
const astra = { provider: "openrouter", model_id: "openai/gpt-6-astra" } as const

const actorInstructions = `
You are a research assistant.
Use fetched sources and delegated work when they improve the answer.
Return a clear answer with concrete findings.
`.trim()

export default actor({
  name: actorName,
  methods: agentMethods,
  components: [
    infer([
      system(actorInstructions),
      budget([
        codeMode([fetchPackage(), agentsPackage({ maxDepth: 2 }), workspacePackage()])
      ], { authority: caller() }),
      compaction(),
      outputValidateOnce
    ], { models: { default: astra, allow: [{ provider: astra.provider, model_ids: [astra.model_id] }] } }),
    budgetAuthority()
  ]
})
