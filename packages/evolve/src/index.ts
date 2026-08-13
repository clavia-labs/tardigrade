// The public surface of @flamecast/evolve. This is the one file in the package that re-exports:
// every doc snippet imports from "@flamecast/evolve", and a library owes its consumers one door.
// Inside the package, a module imports from the file that defines the symbol.
//
// The package holds the mechanics of a harness search and none of its judgment. There is no proposer
// prompt and no metric here, because neither one is portable across domains.

export { candidate, type Candidate, type CandidateOptions } from "./candidate"
export {
  modelCallPrefixes,
  observationOf,
  observationallyEquivalent,
  type ProgramObservation
} from "./observe"
export {
  divergence,
  rollout,
  type Divergence,
  type RolloutOptions,
  type RolloutResult
} from "./rollout"
export { paretoArchive, type Identified, type ParetoArchive, type Scores } from "./pareto"
export { scoreOf, spendOf, verdictsOf, type Verdict } from "./score"
