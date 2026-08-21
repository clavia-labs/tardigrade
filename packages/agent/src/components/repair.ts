import type { Event } from "@clavia/tardigrade-core/event"
import { turnView } from "@clavia/tardigrade-code/turns"
import { contractOf, type OutputImplementation } from "../output"
import type { AgentComponent } from "../runtime/agent"

// The repair component: one output implementation, for a provider that offers no strict schema
// guarantee. It asks for the contract in the system text, judges the reply locally, and gives
// the model its own reasons back for a bounded number of corrections. It is a component a
// consumer mounts, never a fallback the framework reaches for: an agent that mounts nothing
// takes the native implementation, and a provider that cannot honour it fails before it spends
// anything (src/output.ts, NATIVE_OUTPUT; platform/model/src/output.ts, outputPreflight).
//
// The implementation it contributes is a value, so a domain-specific mechanism is the same move:
// a component whose view carries its own OutputImplementation and whose system text asks for the
// contract its own way.

// RepairPolicy is the correction bound and the history rule. `attempts` is how many corrections
// one turn epoch may spend, so a policy of two asks the model three times at most; a rejection
// past the bound ends the turn with `output_repairs_exhausted`. `projectHistory` compacts a
// corrected exchange out of later renders: the rejected reply and its reasons stop being
// rendered once the turn completes, so later inference reads the corrected value as the answer,
// while the log keeps every rejection (request.ts, renderMessages).
export interface RepairPolicy {
  readonly attempts: number
  readonly projectHistory: boolean
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = { attempts: 2, projectHistory: true }

export const repairPolicyOf = (policy: Partial<RepairPolicy> = {}): RepairPolicy => ({
  attempts: policy.attempts ?? DEFAULT_REPAIR_POLICY.attempts,
  projectHistory: policy.projectHistory ?? DEFAULT_REPAIR_POLICY.projectHistory
})

// repairImplementation is the value the component contributes to the view. `guarantee: "none"`
// tells the binding to send no schema, so no provider is asked for a promise it cannot keep;
// `onMismatch: "reject"` records the reply for correction instead of ending the turn.
export const repairImplementation = (policy: Partial<RepairPolicy> = {}): OutputImplementation => {
  const resolved = repairPolicyOf(policy)
  return {
    name: "repair",
    guarantee: "none",
    onMismatch: "reject",
    attempts: resolved.attempts,
    projectHistory: resolved.projectHistory
  }
}

// repairSystemFor is what the model reads instead of a response format. It states the schema and
// asks for that JSON alone, because a provider with no strict mode has only the prompt.
export const repairSystemFor = (name: string, schema: unknown): string =>
  `Your final reply for this turn must be JSON conforming to the schema "${name}":\n${JSON.stringify(schema)}\nReply with that JSON alone: no prose around it, no code fence. A reply that misses the schema comes back with its reasons for you to correct.`

// outputRepairFor derives the implementation and, for a turn that declares a contract, the
// instruction that asks for it. A turn with no contract contributes nothing at all, so mounting
// this component costs an undeclared turn no prompt.
export const outputRepairFor = (policy: Partial<RepairPolicy> = {}): AgentComponent => {
  const implementation = repairImplementation(policy)
  return {
    name: "output.repair",
    derive: (log: ReadonlyArray<Event>) => {
      const contract = contractOf(turnView(log))
      return {
        view: {
          system: contract === undefined ? [] : [repairSystemFor(contract.name, contract.schema)],
          tools: [],
          context: [],
          output: [{ component: "output.repair", implementation }]
        },
        transitions: []
      }
    }
  }
}

// outputRepair is the component under the default policy.
export const outputRepair: AgentComponent = outputRepairFor()
