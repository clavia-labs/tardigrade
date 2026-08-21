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

const actorName = "researcher"

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
  actor: agentOf([
    instructions,
    codeModeFor({
      packages: [filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()]
    }),
    reply,
    budget,
    compaction
  ])
})
