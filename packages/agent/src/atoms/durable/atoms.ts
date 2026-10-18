import type { StatefulAtom, Atom } from "@clavia/tardigrade-core"
import { contextState } from "./context"
import { historyRecords } from "../activity"
import { promiseRecords } from "../tool-promises"
import { budgetRecords } from "./budget"
import { executionRecords } from "./code-mode"
import { createCompactionState } from "./compaction"
import { modelState } from "./model"
import { inferenceState } from "./inference"
import { permissionRecords } from "./permissions"
import { spendRecords } from "./spend"
import { toolRecords } from "./tools"
import { trajectoryState } from "./trajectory"

export const agentDurableAtoms: readonly (StatefulAtom & Atom<unknown>)[] = [
  trajectoryState, contextState, modelState, inferenceState, spendRecords, permissionRecords, budgetRecords, toolRecords,
  createCompactionState(), executionRecords, promiseRecords, historyRecords,
]
