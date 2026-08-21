import type { Event } from "@clavia/tardigrade-core/event"
import { turnView } from "@clavia/tardigrade-code/turns"
import { correctionAttemptsErrors, declaredOutputOf, type OutputFallback } from "../output"
import type { AgentComponent } from "../runtime/agent"

// The two output fallbacks a consumer mounts, and the seam a third is written against. A
// fallback says what a turn does when native structured output is unavailable for the call, and
// nothing else: mounting one never turns native output off, so an endpoint that guarantees a
// strict schema still serves the contract from its own response format
// (platform/model/src/output.ts, outputModeOf).
//
// `outputFailFast` takes the answer the model gives and validates it once. A mismatch ends the
// turn with `output_validation_failed`, which is a decision rather than a default: choosing not
// to retry is stated by mounting this.
//
// `outputRepair` is the framework's correction loop. The infer reactor hands a missed reply back
// with `correctionText` for a bounded number of asks. That loop and that sentence are this
// component's, and nothing else in the framework uses them: a domain-specific mechanism mounts a
// `delegated` fallback, reads the typed `OutputRejected`, and decides its own feedback, its own
// bound, and whether to ask again at all (src/output.ts, asksAgain; docs/output.md).
//
// An assembly that mounts neither has no fallback, so a contract an endpoint cannot serve
// natively fails before it spends anything (platform/model/src/output.ts, outputPreflight).

// RepairPolicy is the correction bound and the history rule. `attempts` is how many corrections
// one turn epoch may spend, so a policy of two asks the model three times at most; a rejection
// past the bound ends the turn with `output_repairs_exhausted`. `projectHistory` compacts a
// corrected exchange out of later renders, the context measure, and the summary brief: the
// rejected reply and its reasons stop being read once the turn completes, while the log keeps
// every rejection (src/output.ts, projectedOutput).
export interface RepairPolicy {
  readonly attempts: number
  readonly projectHistory: boolean
}

export const DEFAULT_REPAIR_POLICY: RepairPolicy = { attempts: 2, projectHistory: true }

// repairPolicyOf fills an override with the defaults, and refuses a bound that is not a whole
// count of asks. A fractional or negative bound would otherwise be floored inside a comparison at
// a turn, far from the line that stated it (turn.test.ts, "a bound that is not a whole count of
// asks is refused where it is stated").
export const repairPolicyOf = (policy: Partial<RepairPolicy> = {}): RepairPolicy => {
  const attempts = policy.attempts ?? DEFAULT_REPAIR_POLICY.attempts
  const problems = correctionAttemptsErrors(attempts)
  if (problems.length > 0) throw new Error(`the repair policy is not applicable: ${problems.join("; ")}`)
  return { attempts, projectHistory: policy.projectHistory ?? DEFAULT_REPAIR_POLICY.projectHistory }
}

// repairFallback is the value the component contributes to the view. `kind: "repair"` is what
// tells the infer reactor that this loop is the framework's to drive.
export const repairFallback = (policy: Partial<RepairPolicy> = {}): OutputFallback => {
  const resolved = repairPolicyOf(policy)
  return {
    kind: "repair",
    name: "repair",
    attempts: resolved.attempts,
    projectHistory: resolved.projectHistory
  }
}

// outputSystemFor is what the model reads when no response format constrains it. It states the
// schema and asks for that JSON alone, because a fallback has only the prompt. It rides the
// output request rather than the base prompt, so an attempt that runs natively never sees it and
// a mounted fallback stays dormant (runtime/agent.ts, OutputFragment).
export const outputSystemFor = (name: string, schema: unknown): string =>
  `Your final reply for this turn must be JSON conforming to the schema "${name}":\n${JSON.stringify(schema)}\nReply with that JSON alone: no prose around it, no code fence.`

// declaredSystem is the shared derivation of both components below: the fallback's instruction
// for a turn that declares a contract, and nothing for one that does not.
const declaredSystem = (log: ReadonlyArray<Event>): { readonly system?: string } => {
  const declared = declaredOutputOf(turnView(log))
  return declared.kind === "contract"
    ? { system: outputSystemFor(declared.contract.name, declared.contract.schema) }
    : {}
}

// outputRepairFor derives the framework correction loop under a stated policy.
export const outputRepairFor = (policy: Partial<RepairPolicy> = {}): AgentComponent => {
  const fallback = repairFallback(policy)
  return {
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
  }
}

// outputRepair is the component under the default policy.
export const outputRepair: AgentComponent = outputRepairFor()

// FAIL_FAST_FALLBACK is the local fallback: one reading of the answer, no correction, and a
// missed response ends the turn.
export const FAIL_FAST_FALLBACK: OutputFallback = { kind: "local", name: "fail-fast" }

// outputFailFast asks for the contract in the system text the same way, and stops at the first
// reply that misses it. The decision not to ask twice is what makes this a different
// implementation rather than a setting on the one above (turn.test.ts, "the fail-fast
// implementation").
export const outputFailFast: AgentComponent = {
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
}
