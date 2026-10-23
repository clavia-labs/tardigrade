import type { StatefulAtom } from "@clavia/tardigrade-core"
import { toolPromiseSubmissions } from "../tool-promises"
import { budgetState } from "./budget"
import { executions } from "./code-mode"
import { createCompactionState } from "./compaction"
import { modelState } from "./model"
import { inferenceState } from "./inference"
import { permissionState } from "./permissions"
import { spendState } from "./spend"
import { pendingTools } from "./tools"

export const agentDurableAtoms: readonly StatefulAtom[] = [
  modelState, inferenceState, spendState, permissionState, budgetState, pendingTools,
  createCompactionState(), executions, toolPromiseSubmissions,
]
