import type { StatefulAtom } from "@clavia/tardigrade-core"
import { history } from "../activity"
import { toolPromiseSubmissions } from "../tool-promises"
import { budgetState } from "./budget"
import { executions } from "./code-mode"
import { createCompactionState } from "./compaction"
import { inferenceState } from "./inference"
import { permissionState } from "./permissions"
import { spendSource } from "./spend"
import { pendingTools } from "./tools"
import { trajectorySource } from "./trajectory"

// agentDurableAtoms lists the agent package's durable atoms for initialStateAtoms and initialiseState, including every atom a default agent checkpoint captures (packages/platform/test/bun/agent-durable-atoms.test.ts).
export const agentDurableAtoms: readonly StatefulAtom[] = [
  trajectorySource, inferenceState, spendSource, permissionState, budgetState, pendingTools,
  createCompactionState(), executions, toolPromiseSubmissions, history,
]
