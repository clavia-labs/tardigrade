export { type AgentPolicy, type AgentR, type RlmR, receive } from "./turn"
export {
  ACTOR_ARTIFACT_VERSION,
  ACTOR_NAME_PATTERN,
  defineActor,
  type ActorArtifactManifest,
  type ActorDefinition
} from "./artifact"

// The parts a caller lists. An agent is components over one log; the reactors underneath remain
// reachable for a bespoke assembly.
export {
  inferReactorFor,
  Infer,
  NativeOutputSupport,
  DEFAULT_INFER_POLICY,
  type InferPolicy,
  type InferRequest,
  type Render
} from "./runtime/infer"

// The turn's declared final response: the contract a caller states, the profile a binding can
// send unchanged, and the implementation that obtains it. `output` is the whole declarative
// surface; everything else here is for an assembly that states its own implementation
// (docs/output.md).
export {
  output,
  outputFrom,
  outputErrors,
  outputNameErrors,
  outputProfileErrors,
  decodeOutput,
  declarationOf,
  declarationForTurn,
  declaredOutputOf,
  canonicalOf,
  fingerprintOf,
  projectedOutput,
  correctionText,
  correctionAttemptsErrors,
  correctionsOf,
  fallbackOf,
  modeOf,
  mismatchCauseOf,
  projectsHistory,
  asksAgain,
  recordsRejection,
  NATIVE_MODE,
  OUTPUT_NAME_PATTERN,
  OUTPUT_STRING_FORMATS,
  OutputContract,
  type Decoded,
  type DeclaredOutput,
  type InProfile,
  type OutputFallback,
  type OutputMode,
  type OutputProblems,
  type OutputSchema,
  type OutputStringFormat
} from "./output"
export {
  outputRepair,
  outputRepairFor,
  outputValidateOnce,
  outputSystemFor,
  repairFallback,
  repairPolicyOf,
  VALIDATE_ONCE_FALLBACK,
  DEFAULT_REPAIR_POLICY,
  type RepairPolicy
} from "./components/repair"
export { nativeOutput } from "./components/native-output"
export { budgetReactorFor, DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./components/budget"
export { toolsReactorFrom, type Answer, type PendingCall, type Serve } from "./runtime/tools"
export { replyReactor } from "./components/reply"
export { compactionReactorFor, DEFAULT_CONTEXT_POLICY, type ContextPolicy } from "./components/compaction"
export { agentKeys, outputRetryRequested, TURN_FAILURE_CAUSES, type TurnFailureCause } from "./events"
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
export { boundaryOf, outputOf, type Boundary } from "./boundary"

// The spawn package: a value with no lane in it, so the assembly that mounts it and the host
// that binds Router, Self, and Facets per lane cannot disagree about placement (spawn.ts).
export { agentsPackage, INLINE_OUTPUT_NAME, type SpawnOptions } from "./spawn"

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

// The component assembly: code mode is the default, and an agent measured against a fixed tool
// list mounts its own (runtime/agent.ts).
export {
  AGENT_VIEW_ALGEBRA,
  infer,
  defineOutputFallback,
  renderOf,
  type AgentComponent,
  type AgentView,
  type AgentTool,
  type ContextFragment,
  type NativeOutputFragment,
  type FallbackOutputFragment,
  type OutputFallbackComponent,
  type OutputFragment,
  type Rendered
} from "./runtime/agent"
export { codeMode, codeModeFor, CODE_SYSTEM, codeSystemFor } from "./components/code"
export { system, type SystemText } from "./components/system"
export { toolList, type NativeTool } from "./components/tool-list"
export { budget, budgetFor } from "./components/budget"
export { compaction, compactionFor } from "./components/compaction"
export { reply } from "./components/reply"
export {
  actor,
  composeComponents,
  reactorOf,
  type Component,
  type ComponentRequirements,
  type Derivation,
  type ViewAlgebra
} from "@clavia/tardigrade-core/component"
