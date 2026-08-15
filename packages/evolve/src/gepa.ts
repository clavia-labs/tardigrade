// The GEPA loop: Pareto selection over a candidate pool, a minibatch check, and a proposer that
// reads the losing trials and writes a better candidate.
//
// The proposer is the half that learns. Selection decides where to spend the next rollout, and
// reflection over natural-language feedback is what turns that rollout into an edit. `mutate` is
// left open because a candidate can be a prompt set, an agent, or a source tree, and only the caller
// knows how to build one. `reflectiveMutation` in `./reflect` fills it with the paper's proposer, and
// that is the callback this loop is shaped for.

import { Effect } from "effect"
import { candidate, type Candidate } from "./candidate"
import {
  sumEvolutionCosts,
  type Costed,
  type EvolutionCost
} from "./cost"
import type { Scores } from "./pareto"

export interface GepaExample<Value> {
  readonly id: string
  readonly value: Value
}

// What one candidate scored on one example, and why. This is the paper's feedback function: the
// metric returns its number together with the text it produced on the way there.
//
// `feedback` is required because it carries the signal the search runs on. A number says a candidate
// reached 0.62. A sentence says which tool it reached for and which fact it missed, and that
// sentence is what a proposer reads when it rewrites an instruction. An evaluator that reports the
// number alone leaves the proposer guessing, and reflective search degrades into random edits, so
// the type asks for the sentence at the point where the evaluator still has it.
export interface GepaEvaluation<Trajectory = unknown> {
  readonly score: number
  readonly feedback: string
  // The candidate's own answer, when the evaluator holds it as text. A reflection shows it beside
  // the feedback so the proposer reads what the candidate actually said.
  readonly output?: string
  readonly trajectory: Trajectory
}

export interface GepaTrial<Example, Evaluation extends GepaEvaluation> {
  readonly example: GepaExample<Example>
  readonly evaluation: Evaluation
  readonly cost: EvolutionCost
}

export interface GepaMutationContext<Value, Example, Evaluation extends GepaEvaluation> {
  readonly iteration: number
  readonly parent: Candidate<Value>
  readonly trials: ReadonlyArray<GepaTrial<Example, Evaluation>>
}

export interface GepaPopulationEntry<Value> {
  readonly candidate: Candidate<Value>
  readonly scores: Scores
  readonly average: number
  readonly cost: EvolutionCost
}

export interface GepaIteration {
  readonly iteration: number
  readonly parent: string
  readonly batch: ReadonlyArray<string>
  readonly parentAverage: number
  readonly proposal?: string
  readonly proposalAverage?: number
  readonly accepted: boolean
  readonly cost: EvolutionCost
}

export interface GepaResult<Value> {
  readonly best: GepaPopulationEntry<Value>
  readonly population: ReadonlyArray<GepaPopulationEntry<Value>>
  readonly front: ReadonlyArray<GepaPopulationEntry<Value>>
  readonly iterations: ReadonlyArray<GepaIteration>
  readonly metricCalls: number
  readonly cost: EvolutionCost
}

export interface GepaOptions<
  Value,
  Example,
  Evaluation extends GepaEvaluation,
  EvaluationError = never,
  EvaluationRequirements = never,
  MutationError = never,
  MutationRequirements = never
> {
  readonly seed: Candidate<Value>
  readonly feedbackExamples: ReadonlyArray<GepaExample<Example>>
  readonly paretoExamples: ReadonlyArray<GepaExample<Example>>
  readonly minibatchSize: number
  readonly maxMetricCalls: number
  readonly evaluate: (
    candidate: Candidate<Value>,
    example: GepaExample<Example>
  ) => Effect.Effect<Costed<Evaluation>, EvaluationError, EvaluationRequirements>
  readonly mutate: (
    context: GepaMutationContext<Value, Example, Evaluation>
  ) => Effect.Effect<
    Costed<Candidate<Value> | undefined>,
    MutationError,
    MutationRequirements
  >
  readonly random?: () => number
}

const averageOf = (scores: ReadonlyArray<number>): number =>
  scores.reduce((total, score) => total + score, 0) / scores.length

const dominates = (left: Scores, right: Scores, examples: ReadonlyArray<string>): boolean => {
  let strictly = false
  for (const example of examples) {
    const leftScore = left[example]
    const rightScore = right[example]
    if (leftScore === undefined || rightScore === undefined) {
      throw new Error(`GEPA candidate is missing the Pareto score for example "${example}"`)
    }
    if (leftScore < rightScore) return false
    if (leftScore > rightScore) strictly = true
  }
  return strictly
}

const leadersByExample = <Value>(
  population: ReadonlyArray<GepaPopulationEntry<Value>>,
  examples: ReadonlyArray<string>
) =>
  examples.map((example) => {
    const best = population.reduce((highest, entry) => {
      const score = entry.scores[example]
      if (score === undefined) {
        throw new Error(`GEPA candidate is missing the Pareto score for example "${example}"`)
      }
      return Math.max(highest, score)
    }, Number.NEGATIVE_INFINITY)
    return new Set(
      population
        .filter((entry) => entry.scores[example] === best)
        .map((entry) => entry.candidate.id)
    )
  })

const frontOf = <Value>(
  population: ReadonlyArray<GepaPopulationEntry<Value>>,
  examples: ReadonlyArray<string>
) => {
  const leaders = leadersByExample(population, examples)
  const leaderIds = new Set(leaders.flatMap((set) => [...set]))
  const candidates = population.filter((entry) => leaderIds.has(entry.candidate.id))
  return candidates.filter(
    (entry) =>
      !candidates.some(
        (other) =>
          other !== entry && dominates(other.scores, entry.scores, examples)
      )
  )
}

const randomIndex = (length: number, random: () => number): number =>
  Math.max(0, Math.min(length - 1, Math.floor(random() * length)))

const selectParent = <Value>(
  population: ReadonlyArray<GepaPopulationEntry<Value>>,
  examples: ReadonlyArray<string>,
  random: () => number
) => {
  const leaders = leadersByExample(population, examples)
  const front = frontOf(population, examples)
  const weights = front.map((entry) =>
    leaders.filter((set) => set.has(entry.candidate.id)).length
  )
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let draw = randomIndex(total, random)
  for (const [index, entry] of front.entries()) {
    draw -= weights[index]!
    if (draw < 0) return entry
  }
  return front.at(-1)!
}

const sampleBatch = <Value>(
  examples: ReadonlyArray<GepaExample<Value>>,
  size: number,
  random: () => number
) => {
  const available = [...examples]
  const sampled: Array<GepaExample<Value>> = []
  while (sampled.length < size) {
    sampled.push(available.splice(randomIndex(available.length, random), 1)[0]!)
  }
  return sampled
}

const validateOptions = <
  Value,
  Example,
  Evaluation extends GepaEvaluation,
  EvaluationError,
  EvaluationRequirements,
  MutationError,
  MutationRequirements
>(
  options: GepaOptions<
    Value,
    Example,
    Evaluation,
    EvaluationError,
    EvaluationRequirements,
    MutationError,
    MutationRequirements
  >
) => {
  if (options.feedbackExamples.length === 0) {
    throw new Error("GEPA requires at least one feedback example")
  }
  if (options.paretoExamples.length === 0) {
    throw new Error("GEPA requires at least one Pareto example")
  }
  if (
    !Number.isInteger(options.minibatchSize) ||
    options.minibatchSize < 1 ||
    options.minibatchSize > options.feedbackExamples.length
  ) {
    throw new Error("GEPA minibatchSize must be a positive integer within the feedback set")
  }
  if (
    !Number.isInteger(options.maxMetricCalls) ||
    options.maxMetricCalls < options.paretoExamples.length
  ) {
    throw new Error("GEPA maxMetricCalls must cover the initial Pareto evaluation")
  }
  const ids = new Set<string>()
  for (const example of options.paretoExamples) {
    if (ids.has(example.id)) {
      throw new Error(`GEPA received duplicate Pareto example id "${example.id}"`)
    }
    ids.add(example.id)
  }
}

const withParent = <Value>(proposal: Candidate<Value>, parent: Candidate<Value>) => {
  if (proposal.parent !== undefined && proposal.parent !== parent.id) {
    throw new Error(
      `GEPA proposal "${proposal.id}" names parent "${proposal.parent}" instead of "${parent.id}"`
    )
  }
  return proposal.parent === undefined
    ? candidate(proposal.id, proposal.value, {
        parent: parent.id,
        ...(proposal.source === undefined ? {} : { source: proposal.source })
      })
    : proposal
}

export const gepa = <
  Value,
  Example,
  Evaluation extends GepaEvaluation,
  EvaluationError,
  EvaluationRequirements,
  MutationError,
  MutationRequirements
>(
  options: GepaOptions<
    Value,
    Example,
    Evaluation,
    EvaluationError,
    EvaluationRequirements,
    MutationError,
    MutationRequirements
  >
) => {
  validateOptions(options)
  const random = options.random ?? Math.random
  return Effect.gen(function* () {
    let metricCalls = 0
    const evaluate = (
      evaluated: Candidate<Value>,
      examples: ReadonlyArray<GepaExample<Example>>
    ) =>
      Effect.gen(function* () {
        const trials: Array<GepaTrial<Example, Evaluation>> = []
        const costs: Array<EvolutionCost> = []
        for (const example of examples) {
          const evaluatedExample = yield* options.evaluate(evaluated, example)
          const evaluation = evaluatedExample.value
          metricCalls += 1
          if (!Number.isFinite(evaluation.score)) {
            throw new Error(
              `GEPA evaluator returned a non-finite score for example "${example.id}"`
            )
          }
          trials.push({ example, evaluation, cost: evaluatedExample.cost })
          costs.push(evaluatedExample.cost)
        }
        return { trials, cost: sumEvolutionCosts(costs) }
      })

    const scoreOnPareto = (evaluated: Candidate<Value>) =>
      Effect.map(evaluate(evaluated, options.paretoExamples), ({ trials, cost }) => {
        const scores = Object.fromEntries(
          trials.map((trial) => [trial.example.id, trial.evaluation.score])
        )
        return {
          candidate: evaluated,
          scores,
          average: averageOf(trials.map((trial) => trial.evaluation.score)),
          cost
        } satisfies GepaPopulationEntry<Value>
      })

    const seed = yield* scoreOnPareto(options.seed)
    let totalCost = seed.cost
    const population: Array<GepaPopulationEntry<Value>> = [seed]
    const iterations: Array<GepaIteration> = []
    const exampleIds = options.paretoExamples.map((example) => example.id)
    const callsForAcceptableIteration =
      options.minibatchSize * 2 + options.paretoExamples.length

    while (metricCalls + callsForAcceptableIteration <= options.maxMetricCalls) {
      const iteration = iterations.length
      const parent = selectParent(population, exampleIds, random)
      const batch = sampleBatch(options.feedbackExamples, options.minibatchSize, random)
      const parentEvaluation = yield* evaluate(parent.candidate, batch)
      const parentTrials = parentEvaluation.trials
      const parentAverage = averageOf(
        parentTrials.map((trial) => trial.evaluation.score)
      )
      const mutation = yield* options.mutate({
        iteration,
        parent: parent.candidate,
        trials: parentTrials
      })
      const proposed = mutation.value
      const iterationCosts: Array<EvolutionCost> = [parentEvaluation.cost, mutation.cost]

      if (proposed === undefined) {
        const cost = sumEvolutionCosts(iterationCosts)
        totalCost = sumEvolutionCosts([totalCost, cost])
        iterations.push({
          iteration,
          parent: parent.candidate.id,
          batch: batch.map((example) => example.id),
          parentAverage,
          accepted: false,
          cost
        })
        continue
      }

      const proposal = withParent(proposed, parent.candidate)
      if (population.some((entry) => entry.candidate.id === proposal.id)) {
        throw new Error(`GEPA proposal id "${proposal.id}" already exists in the population`)
      }
      const proposalEvaluation = yield* evaluate(proposal, batch)
      iterationCosts.push(proposalEvaluation.cost)
      const proposalTrials = proposalEvaluation.trials
      const proposalAverage = averageOf(
        proposalTrials.map((trial) => trial.evaluation.score)
      )
      const accepted = proposalAverage > parentAverage
      if (accepted) {
        const entry = yield* scoreOnPareto(proposal)
        population.push(entry)
        iterationCosts.push(entry.cost)
      }
      const cost = sumEvolutionCosts(iterationCosts)
      totalCost = sumEvolutionCosts([totalCost, cost])
      iterations.push({
        iteration,
        parent: parent.candidate.id,
        batch: batch.map((example) => example.id),
        parentAverage,
        proposal: proposal.id,
        proposalAverage,
        accepted,
        cost
      })
    }

    const best = population.reduce((leader, entry) =>
      entry.average > leader.average ? entry : leader
    )
    const result: GepaResult<Value> = {
      best,
      population,
      front: frontOf(population, exampleIds),
      iterations,
      metricCalls,
      cost: totalCost
    }
    return result
  })
}
