import type { Event } from "@clavia/tardigrade-core/event"
import { turnView } from "@clavia/tardigrade-code/turns"
import { correctionAttemptsErrors, declaredOutputOf, type OutputFallback } from "../output"
import { defineOutputFallback, type OutputFallbackComponent } from "../runtime/agent"

// RepairPolicy sets the correction limit and completed-history projection. `attempts` counts correction requests after the initial request (src/output.ts, projectedOutput).
export interface RepairPolicy {
  readonly attempts: number
  readonly projectHistory: boolean
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = { attempts: 2, projectHistory: true }

// repairPolicyOf applies DEFAULT_REPAIR_POLICY and validates each override (turn.test.ts, "a bound that is not a whole count of asks is refused where it is stated").
export const repairPolicyOf = (policy: Partial<RepairPolicy> = {}): RepairPolicy => {
  const attempts = policy.attempts ?? DEFAULT_REPAIR_POLICY.attempts
  const problems = correctionAttemptsErrors(attempts)
  if (problems.length > 0) throw new Error(`the repair policy is not applicable: ${problems.join("; ")}`)
  const projectHistory = policy.projectHistory ?? DEFAULT_REPAIR_POLICY.projectHistory
  if (typeof projectHistory !== "boolean") {
    throw new Error(
      `the repair policy is not applicable: projectHistory must be true or false, got ${JSON.stringify(projectHistory)}`
    )
  }
  return { attempts, projectHistory }
}

// repairFallback returns the validated fallback record interpreted by the infer reactor.
export const repairFallback = (policy: Partial<RepairPolicy> = {}): OutputFallback => {
  const resolved = repairPolicyOf(policy)
  return {
    kind: "repair",
    name: "repair",
    attempts: resolved.attempts,
    projectHistory: resolved.projectHistory
  }
}

// outputSystemFor returns the schema instruction used only in fallback mode (runtime/agent.ts, OutputFragment).
export const outputSystemFor = (name: string, schema: unknown): string =>
  `Your final reply for this turn must be JSON conforming to the schema "${name}":\n${JSON.stringify(schema)}\nReply with that JSON alone: no prose around it, no code fence.`

// declaredSystem returns the fallback instruction for the current declared contract.
const declaredSystem = (log: ReadonlyArray<Event>): { readonly system?: string } => {
  const declared = declaredOutputOf(turnView(log))
  return declared.kind === "contract"
    ? { system: outputSystemFor(declared.contract.name, declared.contract.schema) }
    : {}
}

// outputRepairFor derives the framework correction loop under a stated policy.
export const outputRepairFor = (policy: Partial<RepairPolicy> = {}): OutputFallbackComponent => {
  const fallback = repairFallback(policy)
  return defineOutputFallback({
    name: "output.repair",
    derive: (log: ReadonlyArray<Event>) => ({
      view: {
        system: [],
        tools: [],
        context: [],
        output: [{ component: "output.repair", fallback, ...declaredSystem(log) }]
      },
      transitions: []
    })
  })
}

// outputRepair is the component under the default policy.
export const outputRepair: OutputFallbackComponent = outputRepairFor()

// FAIL_FAST_FALLBACK validates one result and schedules no correction.
export const FAIL_FAST_FALLBACK: OutputFallback = { kind: "local", name: "fail-fast" }

// outputFailFast contributes the fail-fast fallback and its contract instruction (turn.test.ts, "the fail-fast implementation").
export const outputFailFast: OutputFallbackComponent = defineOutputFallback({
  name: "output.fail-fast",
  derive: (log: ReadonlyArray<Event>) => ({
    view: {
      system: [],
      tools: [],
      context: [],
      output: [{ component: "output.fail-fast", fallback: FAIL_FAST_FALLBACK, ...declaredSystem(log) }]
    },
    transitions: []
  })
})
