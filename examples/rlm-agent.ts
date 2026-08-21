// A Recursive Language Model agent, assembled from the library's parts and run on the durable
// Bun host: bun run examples/rlm-agent.ts. The agent acts by writing JavaScript; its code can
// spawn child agents (agents.run) and read spilled values back (workspace.read). Set
// MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID to an OpenAI-compatible endpoint before running;
// add provider: "bedrock" to the infer options for Bedrock.

// The workspace names resolve in this repository. Against the published package the last two
// are "tardie/model" and "tardie/bun/host" (tools/publish.ts).
import { agentOf, agentsPackage, boundaryOf, budget, codeModeFor, compaction, outputFailFast, reply, workspacePackage } from "tardie"
import { infer } from "@clavia/tardigrade-model/model"
import { createBunHost } from "@clavia/tardigrade-bun/host"

// The work surface: code mode with the spawn and workspace packages in scope. The packages are
// values, so the model's system fragment lists them and the assembly's requirements carry their
// needs (Router, Self, and Facets for spawn; the spill store for workspace). The Bun host binds
// all of those per lane.
const rlm = agentOf([
  codeModeFor({ packages: [agentsPackage(), workspacePackage()] }),
  reply, // reports each turn's terminal to whoever asked
  budget, // the per-turn code budget, inherited by spawned children
  compaction, // bounded model context over long investigations
  outputFailFast // handles structured results without adding a retry
])

const model = infer({
  baseUrl: process.env.MODEL_BASE_URL!,
  apiKey: process.env.MODEL_API_KEY!,
  model: process.env.MODEL_ID!,
  ...(process.env.MODEL_PROVIDER === undefined ? {} : { provider: process.env.MODEL_PROVIDER })
})

// Every ag. lane runs the same assembly: the root, and every child a spawn births. The lane
// arrives as Self at run time, so one actor value serves the whole family.
const host = await createBunHost({
  log: "agents.sqlite",
  actorFor: (lane) => (lane.startsWith("ag.") ? rlm : undefined),
  layersFor: () => model
})

// One ask: deliver a brief to the root, drive to quiescence, read the boundary the settle left.
// The turn id is the dedup key, so redelivering this exact event is absorbed, and a crash
// mid-run resumes from the log on the next drive.
const root = "ag.root"
const id = "run-1"
await host.deliver(host.self(root), {
  type: "MessageReceived",
  id,
  text: "Investigate the repository layout: spawn one child per top-level directory of your choosing and merge their reports.",
  at: Date.now()
})
await host.drive()

const boundary = boundaryOf(await host.read(root), id)
if (boundary === undefined) console.log("the root never settled")
else if (boundary.kind === "completed") console.log(boundary.output)
else if (boundary.kind === "failed") console.log(`failed: ${boundary.error}`)
else console.log("parked on a budget ask; answer it with agents.continue from a parent")
await host.close()
