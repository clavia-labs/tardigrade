export { type AgentPolicy, type AgentR, type RlmR, receive } from "./turn"
export {
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  defineActor,
  type ActorArtifactManifest,
  type ActorDefinition
} from "./artifact"

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

// Where a settle left a turn. A caller driving its own host reads the answer here, because a
// boundary is a projection of the log rather than a value the driver returns (boundary.ts).
export { boundaryOf, type Boundary } from "./boundary"

// The spawn package: a value with no lane in it, so the assembly that mounts it and the host
// that binds Router, Self, and Facets per lane cannot disagree about placement (spawn.ts).
export { agentsPackage, type SpawnOptions } from "./spawn"

// The workspace the model reads its spilled values back through, and the optional SQL binding a
// platform lights its third verb up with.
export { workspacePackage, workspaceFor, WorkspaceSql, DEFAULT_WORKSPACE_POLICY, workspacePolicyOf, type WorkspacePolicy, type SqlRunner } from "@clavia/tardigrade-code/workspace"

// The two packages that let an assembly reach past its own log: the files under one root, and HTTP
// to any host. Both are built on Effect's platform services, so the host that mounts them binds a
// FileSystem, a Path, and an HttpClient and nothing else changes (packages/code/src/files.ts,
// packages/code/src/fetch.ts).
export {
  filesPackage,
  filesPolicyOf,
  defaultFilesRoot,
  DEFAULT_FILES_READ_CHARS,
  DEFAULT_FILES_MAX_ENTRIES,
  DEFAULT_FILES_MAX_MATCHES,
  DEFAULT_FILES_SKIP,
  type FilesPolicy
} from "@clavia/tardigrade-code/files"
export {
  fetchPackage,
  fetchPolicyOf,
  DEFAULT_FETCH_POLICY,
  DEFAULT_FETCH_BODY_CHARS,
  type FetchPolicy
} from "@clavia/tardigrade-code/fetch"

// The capability assembly: code mode is the default, and an agent measured against a fixed
// tool list mounts its own (capability.ts).
export { agentOf, renderOf, codeMode, codeModeFor, CODE_SYSTEM, codeSystemFor, toolList, reply, budget, budgetFor, compaction, compactionFor, type Capability, type NativeTool } from "./capability"
