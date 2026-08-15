// The public evolution surface. This is the one file in the package that re-exports: a library owes
// its consumers one door. Inside the package, a module imports from the file that defines the
// symbol.
//
// The package holds reusable mechanics and policies for harness search. Callers own proposer prompts
// and metrics because those decisions belong to their domains.

export { candidate, type Candidate, type CandidateOptions } from "./candidate"
export {
  costed,
  evolutionCostOf,
  sumEvolutionCosts,
  zeroEvolutionCost,
  type Costed,
  type EvolutionCost
} from "./cost"
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
  populora,
  populoraConservativeScore,
  populoraRewards,
  populoraWinProbability,
  type PopuloraEvolution,
  type PopuloraEvolutionContext,
  type PopuloraMatch,
  type PopuloraMatchContext,
  type PopuloraMatchOutcome,
  type PopuloraMember,
  type PopuloraOperator,
  type PopuloraOptions,
  type PopuloraRating,
  type PopuloraRatingOptions,
  type PopuloraResult,
  type PopuloraRewards,
  type PopuloraRole,
  type PopuloraSolveOutcome,
  type PopuloraTrial
} from "./populora"
export {
  evaluationOf,
  feedbackOf,
  outputOf,
  proposer,
  reflectionPrompt,
  reflectiveMutation,
  reflectivePrompts,
  type Prompts,
  type Proposer,
  type ProposerOptions,
  type ProposerSession,
  type Reflection,
  type ReflectionTrial,
  type ReflectiveMutationOptions
} from "./reflect"
export {
  divergence,
  rollout,
  type Divergence,
  type RolloutOptions,
  type RolloutResult
} from "./rollout"
export { paretoArchive, type Identified, type ParetoArchive, type Scores } from "./pareto"
export { scoreOf, spendOf, verdictsOf, type Verdict } from "./score"
