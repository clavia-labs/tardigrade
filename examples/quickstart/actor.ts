import {
  actorOf,
  agentRuntime,
  agentsPackage,
  budget,
  codeModeFor,
  compaction,
  defineActor,
  fetchPackage,
  filesPackage,
  outputFailFast,
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
  derive: () => ({
    view: { system: [actorInstructions], tools: [], context: [], output: [] },
    transitions: []
  })
}

export default defineActor({
  name: actorName,
  // actorOf carries component and output requirements into the host type.
  actor: actorOf(agentRuntime(), [
    instructions,
    // codeModeFor gives the model one code tool over the packages listed here.
    codeModeFor({
      // packages grant access to local files, HTTP, child agents, and saved tool results.
      packages: [filesPackage(), fetchPackage(), agentsPackage(), workspacePackage()]
    }),
    // reply returns a finished turn to the actor that delegated it.
    reply,
    // budget stops work tools when the turn reaches its tool-call limit.
    budget,
    // compaction summarizes older context when a long turn outgrows its context window.
    compaction,
    // outputFailFast handles structured results on endpoints with no native guarantee without retrying.
    outputFailFast
  ])
})
