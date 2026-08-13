// The public surface of @flamecast/harness. This is the one file in the package that re-exports:
// every doc snippet imports from "@flamecast/harness", and a library owes its consumers one door.
// Inside the package, a module imports from the file that defines the symbol.

export {
  Infer,
  customInference,
  inferWith,
  selectedInference,
  type Action,
  type AgentMessage,
  type AgentToolCall,
  type CustomInferenceOptions,
  type InferenceProvider,
  type InferenceSelection,
  type InferenceState,
  type ModelRequest,
  type Tool,
  type ToolContext,
  type ToolSpec,
  type Usage
} from "./infer"
export {
  canonicalValue,
  programId,
  readSignal,
  WITHDRAW_ALL,
  type AgentProgram,
  type Instruction,
  type ModuleManifest,
  type Nudge
} from "./program"
export {
  announce,
  signal,
  type Announcement,
  type AnySignal,
  type ModuleContext,
  type Signal,
  type ValueOf
} from "./signal"
export {
  createAgent,
  defineModule,
  undeclaredEvents,
  type Agent,
  type AgentOptions,
  type AgentServices,
  type AnyModule,
  type BranchOptions,
  type InboundMessage,
  type Module,
  type ModulePart,
  type TurnOutcome,
  type TurnResult
} from "./module"
export { defaultPack, type DefaultPackOptions } from "./pack"
export { modelRequest, renderMessages, systemPrompt, toolSurface } from "./render"
export {
  replyView,
  servedLog,
  transcript,
  turnHead,
  turnOf,
  turnView,
  usageIn
} from "./turns"
export { checkpointOf, estimateTokens, keepUpTo, suffixOf, type Checkpoint } from "./context"
export { boundaryOf, type CallResult } from "./boundary"
export { keyOf } from "./keys"
export { answerErrors, repairText } from "./schema"
export { ANSWER, EXITS, REQUEST_BUDGET } from "./exits"
export {
  cloudflareGatewayInference,
  type CloudflareGatewayInferenceOptions
} from "./providers/cloudflare-gateway"
export {
  vercelGatewayInference,
  type VercelGatewayInferenceOptions
} from "./providers/vercel-gateway"
export { inference, inferenceState, type InferenceOptions } from "./modules/inference"
export { agentTool, tools, type AgentToolOptions } from "./modules/tools"
export {
  budgetOf,
  budgetPhase,
  budgetSpent,
  budget,
  canRequestBudget,
  escalatableOf,
  usedOf,
  type BudgetOptions,
  type BudgetPhase
} from "./modules/budget"
export { contract, type ContractOptions } from "./modules/contract"
export {
  COMPRESSION_RATIO,
  KEEP_RATIO,
  TRIGGER_RATIO,
  morphCompaction,
  naiveSummary,
  type MorphOptions
} from "./modules/compaction"
export { nudge, type NudgeOptions } from "./modules/nudge"
