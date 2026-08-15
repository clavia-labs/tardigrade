// The public harness surface. This is the one file in the package that re-exports: a library owes
// its consumers one door. Inside the package, a module imports from the file that defines the
// symbol.

export {
  Infer,
  customInference,
  inferWith,
  selectedInference,
  type Action,
  type AgentMessage,
  type NativeToolCall,
  type CustomInferenceOptions,
  type InferenceProvider,
  type InferenceSelection,
  type InferenceState,
  type ModelRequest,
  type NativeTool,
  type NativeToolContext,
  type NativeToolSpec,
  type Usage
} from "./infer"
export {
  canonicalValue,
  agentId,
  WITHDRAW_ALL,
  type AgentDefinition,
  type Instruction,
  type ModuleManifest,
  type Nudge
} from "./definition"
export type { Projection } from "./projection"
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
  type MessageOrigin,
  type Module,
  type ModulePart,
  type TurnOutcome,
  type TurnResult
} from "./module"
export {
  callAgent,
  subagentResultOf,
  subagentTool,
  type CallAgentMessage,
  type SubagentResult,
  type SubagentToolOptions
} from "./subagent"
export { serve, type Serve, type ServeOptions } from "./serve"
export { defaultPack, type DefaultPackOptions } from "./pack"
export { modelRequest, nativeToolSurface, renderMessages, systemPrompt } from "./render"
export {
  replyView,
  servedLog,
  transcript,
  treeUsageIn,
  turnHead,
  turnOf,
  turnView,
  usageIn
} from "./turns"
export { checkpointOf, estimateTokens, keepUpTo, suffixOf, type Checkpoint } from "./context"
export { boundaryOf, type CallResult } from "./boundary"
export { keyOf } from "./keys"
export {
  answerRejected,
  budgetExhausted,
  budgetRequested,
  compactionCompleted,
  messageReceived,
  modelCalled,
  modelReturned,
  replyDelivered,
  textReturned,
  toolCalled,
  toolReturned,
  turnCompleted,
  turnFailed,
  type Stamped
} from "./alphabet"
export { tool, type ToolOptions } from "./tool"
export { jsonSchemaOf, repairText, schemaErrors } from "./schema"
export { ANSWER, EXITS, REQUEST_BUDGET } from "./exits"
export {
  cloudflareGatewayInference,
  type CloudflareGatewayInferenceOptions
} from "./providers/cloudflare-gateway"
export {
  vercelGatewayInference,
  type VercelGatewayInferenceOptions
} from "./providers/vercel-gateway"
export {
  InferenceStateProjection,
  inference,
  type InferenceOptions
} from "./modules/inference"
export { nativeTools } from "./modules/native-tools"
export {
  budgetOf,
  budgetPhase,
  budgetSpent,
  budget,
  canRequestBudget,
  escalatableOf,
  toolCallsOf,
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
