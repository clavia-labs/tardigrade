import { Effect } from "effect"
import { candidate, type Candidate } from "./candidate"
import type { Scores } from "./pareto"

export interface GepaExample<Value> {
  readonly id: string
  readonly value: Value
}

export interface GepaEvaluation<Trajectory = unknown> {
  readonly score: number
  readonly trajectory: Trajectory
}

export interface GepaTrial<Example, Evaluation extends GepaEvaluation> {
  readonly example: GepaExample<Example>
  readonly evaluation: Evaluation
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
}

export interface GepaIteration {
  readonly iteration: number
  readonly parent: string
  readonly batch: ReadonlyArray<string>
  readonly parentAverage: number
  readonly proposal?: string
  readonly proposalAverage?: number
  readonly accepted: boolean
}

export interface GepaResult<Value> {
  readonly best: GepaPopulationEntry<Value>
  readonly population: ReadonlyArray<GepaPopulationEntry<Value>>
  readonly front: ReadonlyArray<GepaPopulationEntry<Value>>
  readonly iterations: ReadonlyArray<GepaIteration>
  readonly metricCalls: number
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
  ) => Effect.Effect<Evaluation, EvaluationError, EvaluationRequirements>
  readonly mutate: (
    context: GepaMutationContext<Value, Example, Evaluation>
  ) => Effect.Effect<Candidate<Value> | undefined, MutationError, MutationRequirements>
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
        for (const example of examples) {
          const evaluation = yield* options.evaluate(evaluated, example)
          metricCalls += 1
          if (!Number.isFinite(evaluation.score)) {
            throw new Error(
              `GEPA evaluator returned a non-finite score for example "${example.id}"`
            )
          }
          trials.push({ example, evaluation })
        }
        return trials
      })

    const scoreOnPareto = (evaluated: Candidate<Value>) =>
      Effect.map(evaluate(evaluated, options.paretoExamples), (trials) => {
        const scores = Object.fromEntries(
          trials.map((trial) => [trial.example.id, trial.evaluation.score])
        )
        return {
          candidate: evaluated,
          scores,
          average: averageOf(trials.map((trial) => trial.evaluation.score))
        } satisfies GepaPopulationEntry<Value>
      })

    const population: Array<GepaPopulationEntry<Value>> = [yield* scoreOnPareto(options.seed)]
    const iterations: Array<GepaIteration> = []
    const exampleIds = options.paretoExamples.map((example) => example.id)
    const callsForAcceptableIteration =
      options.minibatchSize * 2 + options.paretoExamples.length

    while (metricCalls + callsForAcceptableIteration <= options.maxMetricCalls) {
      const iteration = iterations.length
      const parent = selectParent(population, exampleIds, random)
      const batch = sampleBatch(options.feedbackExamples, options.minibatchSize, random)
      const parentTrials = yield* evaluate(parent.candidate, batch)
      const parentAverage = averageOf(
        parentTrials.map((trial) => trial.evaluation.score)
      )
      const proposed = yield* options.mutate({
        iteration,
        parent: parent.candidate,
        trials: parentTrials
      })

      if (proposed === undefined) {
        iterations.push({
          iteration,
          parent: parent.candidate.id,
          batch: batch.map((example) => example.id),
          parentAverage,
          accepted: false
        })
        continue
      }

      const proposal = withParent(proposed, parent.candidate)
      if (population.some((entry) => entry.candidate.id === proposal.id)) {
        throw new Error(`GEPA proposal id "${proposal.id}" already exists in the population`)
      }
      const proposalTrials = yield* evaluate(proposal, batch)
      const proposalAverage = averageOf(
        proposalTrials.map((trial) => trial.evaluation.score)
      )
      const accepted = proposalAverage > parentAverage
      if (accepted) population.push(yield* scoreOnPareto(proposal))
      iterations.push({
        iteration,
        parent: parent.candidate.id,
        batch: batch.map((example) => example.id),
        parentAverage,
        proposal: proposal.id,
        proposalAverage,
        accepted
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
      metricCalls
    }
    return result
  })
}
