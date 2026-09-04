import {
  actor,
  agentMethods,
  agentsPackage,
  budget,
  budgetAuthority,
  caller,
  codeMode,
  compaction,
  fetchPackage,
  infer,
  outputValidateOnce,
  system,
  workspacePackage
} from "tardie"

const actorName = "react-chat"

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
        codeMode([fetchPackage(), agentsPackage(), workspacePackage()])
      ], { authority: caller() }),
      compaction(),
      outputValidateOnce
    ]),
    budgetAuthority()
  ]
})
