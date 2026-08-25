import {
  actor, agentMethods, agentsPackage, budget, codeMode,
  compaction, defineActor, fetchPackage, filesPackage, infer,
  outputValidateOnce, reply, system, workspacePackage
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

export default defineActor({
  name: actorName,
  // methods declares the typed calls this actor accepts.
  methods: agentMethods,
  // actor carries component and output requirements into the host type.
  actor: actor(infer([
    system(actorInstructions),
    // budget scopes the tool-call limit to the codeMode subtree.
    budget([
      // codeMode gives the model one code tool over the package components listed here.
      codeMode([
        // codeMode package components grant access to files, HTTP, child agents, and saved results.
        filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()
      ])
    ]),
    // reply returns a finished turn to the actor that delegated it.
    reply,
    // compaction summarizes older context when a long turn outgrows its context window.
    compaction(),
    // outputValidateOnce validates one structured result when the endpoint supplies no native guarantee.
    outputValidateOnce
  ], actorModel))
})
