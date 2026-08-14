// The public evolution surface. This is the one file in the package that re-exports: a library owes
// its consumers one door. Inside the package, a module imports from the file that defines the
// symbol.
//
// The package holds reusable mechanics and policies for harness search. Callers own proposer prompts
// and metrics because those decisions belong to their domains.

export { candidate, type Candidate, type CandidateOptions } from "./candidate"
export {
  gepa,
  type GepaEvaluation,
  type GepaExample,
  type GepaIteration,
  type GepaMutationContext,
  type GepaOptions,
  type GepaPopulationEntry,
  type GepaResult,
  type GepaTrial
} from "./gepa"
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
