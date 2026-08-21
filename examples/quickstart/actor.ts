import {
  agentOf,
  agentsPackage,
  budget,
  codeModeFor,
  compaction,
  defineActor,
  fetchPackage,
  filesPackage,
  reply,
  workspacePackage
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

const instructions = {
  name: "instructions",
  system: actorInstructions
}

export default defineActor({
  name: actorName,
  // agentOf combines small capabilities into the actor's behavior.
  actor: agentOf([
    instructions,
    // codeModeFor gives the model one code tool over the packages listed here.
    codeModeFor({
      // packages grant access to local files, HTTP, child agents, and saved tool results.
      packages: [filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()]
    }),
    // reply, budget, and compaction provide completion, bounded work, and long-run context.
    reply,
    budget,
    compaction
  ])
})
