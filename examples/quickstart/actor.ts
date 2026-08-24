import {
  actor, agentMethods, agentsPackage, budget, codeMode,
  compaction, defineActor, fetchPackage, filesPackage, infer,
  outputValidateOnce, reply, system, workspacePackage
} from "tardie"

// actorName is the stable name used by build, push, and run.
const actorName = "researcher"

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
    // codeMode gives the model one code tool over the components listed here.
    codeMode([
      // Package components grant access to local files, HTTP, child agents, and saved tool results.
      filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()
    ]),
    // reply returns a finished turn to the actor that delegated it.
    reply,
    // budget stops work tools when the turn reaches its tool-call limit.
    budget,
    // compaction summarizes older context when a long turn outgrows its context window.
    compaction(),
    // outputValidateOnce validates one structured result when the endpoint supplies no native guarantee.
    outputValidateOnce
  ]))
})
