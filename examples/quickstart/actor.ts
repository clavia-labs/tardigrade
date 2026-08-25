import {
  actor, agentMethods, agentsPackage, budget, codeMode,
  compaction, fetchPackage, filesPackage, infer,
  outputValidateOnce, system, workspacePackage
} from "tardie"

// actorName is the stable name used by build, development, and deployment.
const actorName = "researcher"
const actorModel = { provider: "openai", default_model: "gpt-5.2" } as const

// actorInstructions is the main place to describe the job and its expected answer.
const actorInstructions = `
You are ${actorName}, a focused research agent.

Investigate the user's request carefully.
Use project files as evidence.
Delegate independent research when it helps.
Return a concise answer with concrete findings.
`.trim()

export default actor({
  name: actorName,
  // methods declares the typed calls this actor accepts.
  methods: agentMethods,
  // components carry implementation and output requirements into the host type.
  components: [infer([
    system(actorInstructions),
    // budget scopes the tool-call limit to the codeMode subtree.
    budget([
      // codeMode gives the model one code tool over the package components listed here.
      codeMode([
        // codeMode package components grant access to files, HTTP, child agents, and saved results.
        filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()
      ])
    ]),
    // compaction summarizes older context when a long turn outgrows its context window.
    compaction(),
    // outputValidateOnce validates one structured result when the endpoint supplies no native guarantee.
    outputValidateOnce
  ], actorModel)]
})
