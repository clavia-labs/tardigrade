import { Effect, Layer } from "effect"
import type { Event } from "@tardigrade/core/event"
import { Router } from "@tardigrade/core/router"
import { Self } from "@tardigrade/core/actor"
import { Packages, type Package } from "@tardigrade/code/packages"
import { jsSandboxFor, memoryTmp } from "@tardigrade/code/defaults"
import type { SandboxPolicy } from "@tardigrade/code/sandbox"
import { createHost, type Host, type LaneEnv } from "@tardigrade/host/host"
import { type AgentPolicy, type RlmR } from "./turn"
import { Infer, type InferRequest } from "./infer"
import type { Action } from "./events"
import { boundaryOf } from "./boundary"
import { agentsPackage } from "./spawn"
import { agentOf, budgetFor, codeModeFor, compactionFor, reply, type Capability } from "./capability"

export { type AgentPolicy, type AgentR, type RlmR, receive } from "./turn"

// The parts a caller lists. An agent is capabilities over one log; the reactors underneath
// remain reachable for a bespoke assembly.
export { inferReactorFor, Infer, DEFAULT_INFER_POLICY, type InferPolicy, type InferRequest, type Render } from "./infer"
export { budgetReactorFor, DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./budget"
export { toolsReactorFrom, type Answer, type PendingCall, type Serve } from "./tools"
export { replyReactor } from "./reply"
export { compactionReactorFor, DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "./compaction"
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

// The capability assembly: code mode is the default, and an agent measured against a fixed
// tool list mounts its own (capability.ts).
export { agentOf, renderOf, codeMode, codeModeFor, toolList, reply, budget, budgetFor, compaction, compactionFor, type Capability, type NativeTool } from "./capability"

export interface CreateAgentOptions {
  readonly packages?: ReadonlyArray<Package>
  // The mind: one inference over the request, one action out. The request carries the render
  // (system, tools) the assembly derived for the attempt.
  readonly infer: (request: InferRequest, key?: string) => Promise<Action>
  // The root lane's history: an agent initialises from a persisted log, because the log is the
  // only state there is. The next run derives from everything here, and work the log still owes
  // settles on the first drive (index.test.ts, "an agent initialises from a log").
  readonly log?: ReadonlyArray<Event>
  // The work capabilities, code mode by default. An agent measured against a fixed tool list
  // passes [toolList([...])]; reply, budget, and compaction are always mounted.
  readonly capabilities?: ReadonlyArray<Capability<RlmR>>
  // Every policy value the assembled agent applies: the give-up and repair ceilings, the default
  // tool budget, the context caps, and the spill bound. Absent fields take the exported
  // defaults. The context policy reaches the render through the compaction capability, so the
  // binding truncates against the numbers the guard fires on (capability.ts, compactionFor).
  readonly policy?: Partial<AgentPolicy>
  // The console cap of the sandbox this function binds. It is separate from `policy` because the
  // sandbox is a seam, not a reactor: an assembly that brings its own Sandbox layer sets the cap
  // there instead (packages/code/src/sandbox.ts, SandboxPolicy).
  readonly sandbox?: Partial<SandboxPolicy>
}

export interface RlmAgent {
  readonly run: (brief: string) => Promise<{ readonly output?: string; readonly error?: string }>
  readonly host: Host
}

const ROOT = "ag.root"

// createRlmAgent is the library default: a hosted Recursive Language Model over an in-process
// host, with spawn and a sandbox (tutorials/rlm-agent.md). It mounts the work capabilities plus
// reply, budget, and compaction, and adds the host and the agents package. A caller who wants a
// thinner assembly uses agentOf and their own host.
export const createRlmAgent = (options: CreateAgentOptions): RlmAgent => {
  const user = options.packages ?? []
  const infer = Layer.succeed(Infer, {
    react: (request: InferRequest, key?: string) => Effect.promise(() => options.infer(request, key))
  })
  const tmp = memoryTmp()
  const sandbox = jsSandboxFor(options.sandbox ?? {})

  // Packages is built from the host's Router and Self. place and the
  // facet reader still close over the host: they name other lanes.
  const layersFor = (_lane: string): LaneEnv<RlmR> => {
    const packages = Layer.effect(
      Packages,
      Effect.gen(function* () {
        const router = yield* Router
        const self = yield* Self
        const spawn = agentsPackage(
          router,
          self,
          (callId) => host.self(`ag.${callId}`),
          { events: (facet: string) => Promise.resolve(host.read(facet)) },
          // A child with no stated budget takes the same ceiling this agent's own wall reads.
          { budget: options.policy?.budget ?? {} }
        )
        const all = [...user, spawn]
        return Packages.of({
          resolve: (name) => all.find((p) => p.name === name),
          list: () => Effect.succeed(all.map((p) => ({ name: p.name, description: p.description })))
        })
      })
    )
    return Layer.mergeAll(packages, sandbox, tmp, infer)
  }

  // Every ag. lane runs the RLM default; anything else is a sink.
  const policy = options.policy ?? {}
  const assembled = agentOf(
    [...(options.capabilities ?? [codeModeFor(policy.code ?? {})]), reply, budgetFor(policy.budget ?? {}), compactionFor(policy.context ?? {})],
    policy.infer ?? {}
  )
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
