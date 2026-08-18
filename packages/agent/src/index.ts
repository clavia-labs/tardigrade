import { Effect, Layer } from "effect"
import type { Event } from "@tardigrade/core/event"
import { Router } from "@tardigrade/core/router"
import { Self } from "@tardigrade/core/actor"
import { Packages, type Package } from "@tardigrade/code/packages"
import { jsSandbox, memoryTmp } from "@tardigrade/code/defaults"
import { createHost, type Host, type LaneEnv } from "@tardigrade/host/host"
import { rlmAgent, rlmAgentFor, type RlmR } from "./turn"
import { Infer } from "./infer"
import type { Action } from "./events"
import { boundaryOf } from "./boundary"
import { agentsPackage } from "./spawn"
import type { ToolSurface } from "./surface"

export { agentFor, rlmAgent, rlmAgentFor, type AgentR, type RlmR } from "./turn"

// The parts a caller lists: reactors and key tables. An agent is reactors over one log.
// Adding a capability is adding a reactor to the list.
export { agentActorKeys, rlmActorKeys } from "./turn"
export { inferReactor, inferReactorFor, Infer, DEFAULT_INFER_POLICY, type InferPolicy } from "./infer"
export { budgetReactor } from "./budget"
export { toolsReactor, toolsReactorFor } from "./tools"
export { replyReactor } from "./reply"
export { compactionReactor } from "./compaction"
export { agentKeys } from "./events"
export {
  usageIn,
  usageOf,
  usageFrom,
  priced,
  costOf,
  sumUsage,
  ZERO_USAGE,
  type Usage,
  type CostSource,
  type ModelPricing
} from "./usage"

// The tool surface: code mode is the default, and an agent measured against a fixed tool table
// brings its own (surface.ts).
export { codeSurface, nativeSurface, type NativeTool, type ToolSurface } from "./surface"

export interface CreateAgentOptions {
  readonly packages?: ReadonlyArray<Package>
  // The mind: one inference over the trajectory, one action out.
  readonly infer: (trajectory: ReadonlyArray<Event>, key?: string) => Promise<Action>
  // The root lane's history: an agent initialises from a persisted log, because the log is the
  // only state there is. The next run derives from everything here, and work the log still owes
  // settles on the first drive (index.test.ts, "an agent initialises from a log").
  readonly log?: ReadonlyArray<Event>
  // The tool surface, code mode by default. The same surface must reach the model binding, so a
  // caller passing one here passes it to `realInfer` too (surface.ts).
  readonly surface?: ToolSurface<RlmR>
}

export interface RlmAgent {
  readonly run: (brief: string) => Promise<{ readonly output?: string; readonly error?: string }>
  readonly host: Host
}

const ROOT = "ag.root"

// createRlmAgent is the library default: a hosted Recursive Language Model over an in-process
// host, with spawn and a sandbox (tutorials/rlm-agent.md). The mind is agentFor; this function
// adds budget, code, compaction, host, and the agents package. A caller who wants a thinner
// harness uses actor([...]) and their own host.
export const createRlmAgent = (options: CreateAgentOptions): RlmAgent => {
  const user = options.packages ?? []
  const infer = Layer.succeed(Infer, {
    react: (trajectory: ReadonlyArray<Event>, key?: string) => Effect.promise(() => options.infer(trajectory, key))
  })
  const tmp = memoryTmp()

  // Packages is built from the host's Router and Self. place and the
  // facet reader still close over the host: they name other lanes.
  const layersFor = (_lane: string): LaneEnv<RlmR> => {
    const packages = Layer.effect(
      Packages,
      Effect.gen(function* () {
        const router = yield* Router
        const self = yield* Self
        const spawn = agentsPackage(router, self, (callId) => host.self(`ag.${callId}`), {
          events: (facet: string) => Promise.resolve(host.read(facet))
        })
        const all = [...user, spawn]
        return Packages.of({
          resolve: (name) => all.find((p) => p.name === name),
          list: () => Effect.succeed(all.map((p) => ({ name: p.name, description: p.description })))
        })
      })
    )
    return Layer.mergeAll(packages, jsSandbox, tmp, infer)
  }

  // Every ag. lane runs the RLM default; anything else is a sink.
  const assembled = options.surface === undefined ? rlmAgent : rlmAgentFor(options.surface)
  const host: Host = createHost<RlmR>({
    principal: "mem",
    actorFor: (lane) => (lane.startsWith("ag.") ? assembled : undefined),
    layersFor
  })

  if (options.log !== undefined && options.log.length > 0) host.seed(ROOT, options.log)

  // Run ids continue past the seeded history, so a resumed agent's new run never wears an id
  // the log already dedups.
  let n = options.log?.length ?? 0
  const run = async (brief: string): Promise<{ readonly output?: string; readonly error?: string }> => {
    const id = `run-${n++}`
    host.deliver(host.self(ROOT), { type: "MessageReceived", id, text: brief, at: n } as Event)
    await host.drive()
    const boundary = boundaryOf(host.read(ROOT), id)
    if (boundary === undefined) return { error: "the root never settled" }
    if (boundary.kind === "completed") return { output: boundary.output }
    if (boundary.kind === "failed") return { error: boundary.error }
    return { error: "the root parked on a budget ask with nobody to answer" }
  }

  return { run, host }
}
