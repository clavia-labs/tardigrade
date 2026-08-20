import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import type { Event } from "@clavia/tardigrade-core/event"
import { assertSupportedBun } from "@clavia/tardigrade-core/runtime"
import type { Actor } from "@clavia/tardigrade-core/actor"
import type { Package } from "@clavia/tardigrade-code/packages"
import { jsSandboxFor } from "@clavia/tardigrade-code/defaults"
import { workspacePackage } from "@clavia/tardigrade-code/workspace"
import type { SandboxPolicy } from "@clavia/tardigrade-code/sandbox"
import { createHost, type Host, type LaneEnv } from "@clavia/tardigrade-host/host"
import { type AgentPolicy, type RlmR } from "./turn"
import { Infer, type InferRequest } from "./infer"
import type { Action } from "./events"
import { boundaryOf } from "./boundary"
import { resumeTurn } from "./resume"
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
export { resumeTurn, type ResumeTurnOptions, type TurnDriver } from "./resume"
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

// The workspace the model reads its spilled values back through, and the optional SQL binding a
// platform lights its third verb up with.
export { workspacePackage, workspaceFor, WorkspaceSql, DEFAULT_WORKSPACE_POLICY, workspacePolicyOf, type WorkspacePolicy, type SqlRunner } from "@clavia/tardigrade-code/workspace"

// The capability assembly: code mode is the default, and an agent measured against a fixed
// tool list mounts its own (capability.ts).
export { agentOf, renderOf, codeMode, codeModeFor, CODE_SYSTEM, codeSystemFor, toolList, reply, budget, budgetFor, compaction, compactionFor, type Capability, type NativeTool } from "./capability"

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
  // tool budget, the context caps, the spill bound, and the workspace's read and grep bounds.
  // Absent fields take the exported
  // defaults. The context policy reaches the render through the compaction capability, so the
  // binding truncates against the numbers the guard fires on (capability.ts, compactionFor).
  readonly policy?: Partial<AgentPolicy>
  // The console cap of the sandbox this function binds. It is separate from `policy` because the
  // sandbox is a seam, not a reactor: an assembly that brings its own Sandbox layer sets the cap
  // there instead (packages/code/src/sandbox.ts, SandboxPolicy).
  readonly sandbox?: Partial<SandboxPolicy>
}

export interface TurnResult {
  readonly turn: string
  readonly output?: string
  readonly error?: string
}

export interface RlmAgent {
  readonly run: (brief: string) => Promise<TurnResult>
  readonly resume: (turn: string) => Promise<TurnResult>
  readonly host: Host
}

const ROOT = "ag.root"

// createRlmAgent is the library default: a hosted Recursive Language Model over an in-process
// host, with spawn and a sandbox. It mounts the work capabilities plus
// reply, budget, and compaction, and adds the host and the agents package. A caller who wants a
// thinner assembly uses agentOf and their own host.
export const createRlmAgent = (options: CreateAgentOptions): RlmAgent => {
  assertSupportedBun()
  const user = options.packages ?? []
  const infer = Layer.succeed(Infer, {
    react: (request: InferRequest, key?: string) => Effect.promise(() => options.infer(request, key))
  })
  // The in-process default spill store: bounded results survive for the life of the process, so
  // replay within a run hydrates them (packages/code/src/store.ts). A durable agent provides its
  // own KeyValueStore layer instead, and binds WorkspaceSql if it has a SQL surface.
  const spillStore = KeyValueStore.layerMemory
  const sandbox = jsSandboxFor(options.sandbox ?? {})

  const layersFor = (_lane: string): LaneEnv<RlmR> => Layer.mergeAll(spillStore, sandbox, infer)

  const policy = options.policy ?? {}
  // This host takes no synchronous calls, so an escalatable spawn's ask and agents.continue
  // refuse here. The spawn package reaches the same Router the host binds per lane, so its
  // doors and the host's cannot disagree (packages/host/src/host.ts, createHost).
  const refused = () => Effect.succeed({ error: "this host takes no synchronous calls" })

  // The spawn package is a value with no lane in it: Router, Self, and Facets serve its methods
  // from the environment the host binds per lane (spawn.ts, agentsPackage). A child with no
  // stated budget takes the same ceiling this agent's own wall reads.
  const spawn = agentsPackage({ budget: policy.budget ?? {} })
  // The workspace reads the same store the spill path writes. This host binds no SQL surface,
  // so it is the two-verb workspace (packages/code/src/workspace.ts, workspacePackage).
  const workspace = workspacePackage({ policy: policy.workspace ?? {} })
  // Every ag. lane runs the RLM default; anything else is a sink. Nothing in the assembly names
  // a lane, so one actor serves them all: the lane arrives as Self, and the packages are values
  // the whole host shares (capability.ts, codeModeFor).
  const assembled = agentOf(
    [
      ...(options.capabilities ?? [codeModeFor(policy.code ?? {}, {}, [...user, spawn, workspace])]),
      reply,
      budgetFor(policy.budget ?? {}),
      compactionFor(policy.context ?? {})
    ],
    policy.infer ?? {}
  )
  const actorFor = (lane: string): Actor<RlmR> | undefined => (lane.startsWith("ag.") ? assembled : undefined)
  const host: Host = createHost<RlmR>({
    principal: "mem",
    actorFor,
    call: refused,
    resume: refused,
    layersFor
  })

  if (options.log !== undefined && options.log.length > 0) host.seed(ROOT, options.log)

  // Run ids continue past the seeded history, so a resumed agent's new run never wears an id
  // the log already dedups.
  let n = options.log?.length ?? 0
  const resultOf = (turn: string): TurnResult => {
    const boundary = boundaryOf(host.read(ROOT), turn)
    if (boundary === undefined) return { turn, error: "the root never settled" }
    if (boundary.kind === "completed") return { turn, output: boundary.output }
    if (boundary.kind === "failed") return { turn, error: boundary.error }
    return { turn, error: "the root parked on a budget ask with nobody to answer" }
  }

  const run = async (brief: string): Promise<TurnResult> => {
    const id = `run-${n++}`
    host.deliver(host.self(ROOT), { type: "MessageReceived", id, text: brief, at: n } as Event)
    await host.drive()
    return resultOf(id)
  }

  const resume = async (turn: string): Promise<TurnResult> => {
    await resumeTurn(host, ROOT, turn)
    return resultOf(turn)
  }

  return { run, resume, host }
}
