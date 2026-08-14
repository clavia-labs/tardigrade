import { Effect } from "effect"
import { candidate, type Candidate } from "./candidate"

export type PopuloraRole = "teacher" | "student"

export type PopuloraSolveOutcome = "correct" | "incorrect" | "format-error"

export type PopuloraMatchOutcome = "teacher" | "student" | "draw"

export type PopuloraOperator = "mutation" | "crossover"

export interface PopuloraRating {
  readonly mu: number
  readonly sigma: number
}

export interface PopuloraRatingOptions {
  readonly initialMu: number
  readonly initialSigma: number
  readonly beta: number
  readonly tau: number
  readonly drawProbability: number
  readonly confidence: number
}

export interface PopuloraTrial<Evidence = unknown> {
  readonly valid: boolean
  readonly outcomes: ReadonlyArray<PopuloraSolveOutcome>
  readonly evidence: Evidence
}

export interface PopuloraRewards {
  readonly teacherReward: number
  readonly studentReward: number
  readonly solveRate: number
}

export interface PopuloraMember<Value> {
  readonly candidate: Candidate<Value>
  readonly rating: PopuloraRating
  readonly generation: number
  readonly parents: ReadonlyArray<string>
}

export interface PopuloraMatchContext<Teacher, Student> {
  readonly step: number
  readonly teacher: PopuloraMember<Teacher>
  readonly student: PopuloraMember<Student>
}

export interface PopuloraMatch<Evidence = unknown> extends PopuloraRewards {
  readonly step: number
  readonly teacher: string
  readonly student: string
  readonly expectedStudentSolveRate: number
  readonly outcome: PopuloraMatchOutcome
  readonly trials: ReadonlyArray<PopuloraTrial<Evidence>>
}

export interface PopuloraEvolutionContext<Value, Evidence = unknown> {
  readonly step: number
  readonly role: PopuloraRole
  readonly operator: PopuloraOperator
  readonly replaced: PopuloraMember<Value>
  readonly parents: ReadonlyArray<PopuloraMember<Value>>
  readonly matches: ReadonlyArray<PopuloraMatch<Evidence>>
}

export interface PopuloraEvolution {
  readonly step: number
  readonly role: PopuloraRole
  readonly operator: PopuloraOperator
  readonly replaced: string
  readonly parents: ReadonlyArray<string>
  readonly child?: string
}

export interface PopuloraResult<Teacher, Student, Evidence = unknown> {
  readonly teachers: ReadonlyArray<PopuloraMember<Teacher>>
  readonly students: ReadonlyArray<PopuloraMember<Student>>
  readonly matches: ReadonlyArray<PopuloraMatch<Evidence>>
  readonly evolutions: ReadonlyArray<PopuloraEvolution>
}

export interface PopuloraOptions<
  Teacher,
  Student,
  Evidence,
  MatchError = never,
  MatchRequirements = never,
  EvolutionError = never,
  EvolutionRequirements = never
> {
  readonly teachers: ReadonlyArray<Candidate<Teacher>>
  readonly students: ReadonlyArray<Candidate<Student>>
  readonly steps: number
  readonly evolutionInterval: number
  readonly cullFraction: number
  readonly crossoverRate?: number
  readonly rating?: Partial<PopuloraRatingOptions>
  readonly initialRating?: (role: PopuloraRole, candidateId: string) => PopuloraRating
  readonly runMatch: (
    context: PopuloraMatchContext<Teacher, Student>
  ) => Effect.Effect<ReadonlyArray<PopuloraTrial<Evidence>>, MatchError, MatchRequirements>
  readonly evolveTeacher: (
    context: PopuloraEvolutionContext<Teacher, Evidence>
  ) => Effect.Effect<Candidate<Teacher> | undefined, EvolutionError, EvolutionRequirements>
  readonly evolveStudent: (
    context: PopuloraEvolutionContext<Student, Evidence>
  ) => Effect.Effect<Candidate<Student> | undefined, EvolutionError, EvolutionRequirements>
  readonly random?: () => number
}

const DEFAULT_RATING: PopuloraRatingOptions = {
  initialMu: 25,
  initialSigma: 25 / 3,
  beta: 25 / 6,
  tau: 25 / 300,
  drawProbability: 0.1,
  confidence: 3
}

const normalPdf = (value: number): number =>
  Math.exp(-(value * value) / 2) / Math.sqrt(2 * Math.PI)

const normalCdf = (value: number): number => {
  if (value === 0) return 0.5
  const absolute = Math.abs(value)
  const scale = 1 / (1 + 0.2316419 * absolute)
  const tail =
    normalPdf(absolute) *
    scale *
    (0.31938153 +
      scale *
        (-0.356563782 +
          scale * (1.781477937 + scale * (-1.821255978 + scale * 1.330274429))))
  return value >= 0 ? 1 - tail : tail
}

const inverseNormalCdf = (probability: number): number => {
  const lower = 0.02425
  const upper = 1 - lower
  if (probability < lower) {
    const value = Math.sqrt(-2 * Math.log(probability))
    return (
      (((((-0.007784894002430293 * value - 0.3223964580411365) * value -
        2.400758277161838) *
        value -
        2.549732539343734) *
        value +
        4.374664141464968) *
        value +
        2.938163982698783) /
      ((((0.007784695709041462 * value + 0.3224671290700398) * value +
        2.445134137142996) *
        value +
        3.754408661907416) *
        value +
        1)
    )
  }
  if (probability > upper) return -inverseNormalCdf(1 - probability)
  const value = probability - 0.5
  const square = value * value
  return (
    (((((-39.69683028665376 * square + 220.9460984245205) * square -
      275.9285104469687) *
      square +
      138.357751867269) *
      square -
      30.66479806614716) *
      square +
      2.506628277459239) *
    value /
    (((((-54.47609879822406 * square + 161.5858368580409) * square -
      155.6989798598866) *
      square +
      66.80131188771972) *
      square -
      13.28068155288572) *
      square +
      1)
  )
}

const validateRating = (rating: PopuloraRating, label: string) => {
  if (!Number.isFinite(rating.mu) || !Number.isFinite(rating.sigma) || rating.sigma <= 0) {
    throw new Error(`PopuLoRA ${label} rating must have a finite mu and a positive sigma`)
  }
}

export const populoraWinProbability = (
  player: PopuloraRating,
  opponent: PopuloraRating,
  beta = DEFAULT_RATING.beta
): number => {
  validateRating(player, "player")
  validateRating(opponent, "opponent")
  if (!Number.isFinite(beta) || beta <= 0) {
    throw new Error("PopuLoRA beta must be a positive finite number")
  }
  const scale = Math.sqrt(
    player.sigma ** 2 + opponent.sigma ** 2 + 2 * beta ** 2
  )
  return normalCdf((player.mu - opponent.mu) / scale)
}

export const populoraConservativeScore = (
  rating: PopuloraRating,
  confidence = DEFAULT_RATING.confidence
): number => {
  validateRating(rating, "candidate")
  if (!Number.isFinite(confidence) || confidence < 0) {
    throw new Error("PopuLoRA confidence must be a non-negative finite number")
  }
  return rating.mu - confidence * rating.sigma
}

const rateWinner = (
  winner: PopuloraRating,
  loser: PopuloraRating,
  options: PopuloraRatingOptions
): readonly [PopuloraRating, PopuloraRating] => {
  const winnerVariance = winner.sigma ** 2 + options.tau ** 2
  const loserVariance = loser.sigma ** 2 + options.tau ** 2
  const scale = Math.sqrt(winnerVariance + loserVariance + 2 * options.beta ** 2)
  const distance = (winner.mu - loser.mu) / scale
  const margin =
    (inverseNormalCdf((options.drawProbability + 1) / 2) *
      Math.sqrt(2) *
      options.beta) /
    scale
  const adjustedDistance = distance - margin
  const correction =
    normalPdf(adjustedDistance) / Math.max(normalCdf(adjustedDistance), 1e-12)
  const shrink = correction * (correction + adjustedDistance)
  return [
    {
      mu: winner.mu + (winnerVariance / scale) * correction,
      sigma: Math.sqrt(
        Math.max(1e-12, winnerVariance * (1 - (winnerVariance / scale ** 2) * shrink))
      )
    },
    {
      mu: loser.mu - (loserVariance / scale) * correction,
      sigma: Math.sqrt(
        Math.max(1e-12, loserVariance * (1 - (loserVariance / scale ** 2) * shrink))
      )
    }
  ]
}

const rateDraw = (
  left: PopuloraRating,
  right: PopuloraRating,
  options: PopuloraRatingOptions
): readonly [PopuloraRating, PopuloraRating] => {
  const leftVariance = left.sigma ** 2 + options.tau ** 2
  const rightVariance = right.sigma ** 2 + options.tau ** 2
  const scale = Math.sqrt(leftVariance + rightVariance + 2 * options.beta ** 2)
  const distance = (left.mu - right.mu) / scale
  const margin =
    (inverseNormalCdf((options.drawProbability + 1) / 2) *
      Math.sqrt(2) *
      options.beta) /
    scale
  const upper = margin - Math.abs(distance)
  const lower = -margin - Math.abs(distance)
  const denominator = Math.max(normalCdf(upper) - normalCdf(lower), 1e-12)
  const baseCorrection = (normalPdf(lower) - normalPdf(upper)) / denominator
  const correction = distance < 0 ? -baseCorrection : baseCorrection
  const shrink =
    correction ** 2 +
    (upper * normalPdf(upper) - lower * normalPdf(lower)) / denominator
  return [
    {
      mu: left.mu + (leftVariance / scale) * correction,
      sigma: Math.sqrt(
        Math.max(1e-12, leftVariance * (1 - (leftVariance / scale ** 2) * shrink))
      )
    },
    {
      mu: right.mu - (rightVariance / scale) * correction,
      sigma: Math.sqrt(
        Math.max(1e-12, rightVariance * (1 - (rightVariance / scale ** 2) * shrink))
      )
    }
  ]
}

export const populoraRewards = <Evidence>(
  trials: ReadonlyArray<PopuloraTrial<Evidence>>
): PopuloraRewards => {
  if (trials.length === 0) throw new Error("PopuLoRA runMatch must return at least one trial")
  const teacherRewards: Array<number> = []
  const studentRewards: Array<number> = []
  let correct = 0
  let attempts = 0
  for (const trial of trials) {
    if (!trial.valid) {
      if (trial.outcomes.length > 0) {
        throw new Error("PopuLoRA invalid trials cannot contain student outcomes")
      }
      teacherRewards.push(-1)
      continue
    }
    if (trial.outcomes.length === 0) {
      throw new Error("PopuLoRA valid trials require at least one student outcome")
    }
    const solved = trial.outcomes.filter((outcome) => outcome === "correct").length
    const solveRate = solved / trial.outcomes.length
    teacherRewards.push(solveRate === 0 ? 0 : 1 - solveRate)
    for (const outcome of trial.outcomes) {
      if (outcome === "correct") {
        studentRewards.push(1)
        correct += 1
      } else if (outcome === "incorrect") {
        studentRewards.push(-0.5)
      } else if (outcome === "format-error") {
        studentRewards.push(-1)
      } else {
        throw new Error(`PopuLoRA received unknown student outcome "${String(outcome)}"`)
      }
      attempts += 1
    }
  }
  const average = (values: ReadonlyArray<number>) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    teacherReward: average(teacherRewards),
    studentReward: average(studentRewards),
    solveRate: attempts === 0 ? 0 : correct / attempts
  }
}

const randomIndex = (length: number, random: () => number): number =>
  Math.max(0, Math.min(length - 1, Math.floor(random() * length)))

const weightedIndex = (weights: ReadonlyArray<number>, random: () => number): number => {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) return randomIndex(weights.length, random)
  let draw = Math.max(0, Math.min(total, random() * total))
  for (const [index, weight] of weights.entries()) {
    draw -= weight
    if (draw <= 0) return index
  }
  return weights.length - 1
}

const ratingOptionsOf = (rating: Partial<PopuloraRatingOptions> | undefined) => ({
  ...DEFAULT_RATING,
  ...rating
})

const validateOptions = <
  Teacher,
  Student,
  Evidence,
  MatchError,
  MatchRequirements,
  EvolutionError,
  EvolutionRequirements
>(
  options: PopuloraOptions<
    Teacher,
    Student,
    Evidence,
    MatchError,
    MatchRequirements,
    EvolutionError,
    EvolutionRequirements
  >,
  rating: PopuloraRatingOptions
) => {
  if (options.teachers.length === 0 || options.students.length === 0) {
    throw new Error("PopuLoRA requires at least one teacher and one student")
  }
  if (!Number.isInteger(options.steps) || options.steps < 0) {
    throw new Error("PopuLoRA steps must be a non-negative integer")
  }
  if (!Number.isInteger(options.evolutionInterval) || options.evolutionInterval < 1) {
    throw new Error("PopuLoRA evolutionInterval must be a positive integer")
  }
  if (
    !Number.isFinite(options.cullFraction) ||
    options.cullFraction <= 0 ||
    options.cullFraction > 1
  ) {
    throw new Error("PopuLoRA cullFraction must be more than zero and at most one")
  }
  const crossoverRate = options.crossoverRate ?? 0.5
  if (!Number.isFinite(crossoverRate) || crossoverRate < 0 || crossoverRate > 1) {
    throw new Error("PopuLoRA crossoverRate must be between zero and one")
  }
  for (const name of [
    "initialMu",
    "initialSigma",
    "beta",
    "tau",
    "drawProbability",
    "confidence"
  ] as const) {
    if (!Number.isFinite(rating[name])) {
      throw new Error(`PopuLoRA rating ${name} must be finite`)
    }
  }
  if (rating.initialSigma <= 0 || rating.beta <= 0) {
    throw new Error("PopuLoRA initialSigma and beta must be positive")
  }
  if (rating.tau < 0 || rating.confidence < 0) {
    throw new Error("PopuLoRA tau and confidence must be non-negative")
  }
  if (rating.drawProbability < 0 || rating.drawProbability >= 1) {
    throw new Error("PopuLoRA drawProbability must be at least zero and less than one")
  }
  for (const [role, values] of [
    ["teacher", options.teachers],
    ["student", options.students]
  ] as const) {
    const ids = new Set<string>()
    for (const value of values) {
      if (ids.has(value.id)) {
        throw new Error(`PopuLoRA received duplicate ${role} id "${value.id}"`)
      }
      ids.add(value.id)
    }
  }
}

const normalizeChild = <Value>(
  proposal: Candidate<Value>,
  parents: ReadonlyArray<PopuloraMember<Value>>
) => {
  const primary = parents[0]!.candidate
  if (proposal.parent !== undefined && proposal.parent !== primary.id) {
    throw new Error(
      `PopuLoRA child "${proposal.id}" names parent "${proposal.parent}" instead of "${primary.id}"`
    )
  }
  return proposal.parent === undefined
    ? candidate(proposal.id, proposal.value, {
        parent: primary.id,
        ...(proposal.source === undefined ? {} : { source: proposal.source })
      })
    : proposal
}

export const populora = <
  Teacher,
  Student,
  Evidence,
  MatchError,
  MatchRequirements,
  EvolutionError,
  EvolutionRequirements
>(
  options: PopuloraOptions<
    Teacher,
    Student,
    Evidence,
    MatchError,
    MatchRequirements,
    EvolutionError,
    EvolutionRequirements
  >
) => {
  const ratingOptions = ratingOptionsOf(options.rating)
  validateOptions(options, ratingOptions)
  const random = options.random ?? Math.random
  const crossoverRate = options.crossoverRate ?? 0.5
  const initialRating = (role: PopuloraRole, candidateId: string) => {
    const rating = options.initialRating?.(role, candidateId) ?? {
      mu: ratingOptions.initialMu,
      sigma: ratingOptions.initialSigma
    }
    validateRating(rating, `${role} "${candidateId}"`)
    return rating
  }

  return Effect.gen(function* () {
    let teachers: Array<PopuloraMember<Teacher>> = options.teachers.map((entry) => ({
      candidate: entry,
      rating: initialRating("teacher", entry.id),
      generation: 0,
      parents: []
    }))
    let students: Array<PopuloraMember<Student>> = options.students.map((entry) => ({
      candidate: entry,
      rating: initialRating("student", entry.id),
      generation: 0,
      parents: []
    }))
    const teacherIds = new Set(teachers.map((entry) => entry.candidate.id))
    const studentIds = new Set(students.map((entry) => entry.candidate.id))
    const matches: Array<PopuloraMatch<Evidence>> = []
    const evolutions: Array<PopuloraEvolution> = []
    let recentMatches: Array<PopuloraMatch<Evidence>> = []

    const updateRating = <Value>(
      population: ReadonlyArray<PopuloraMember<Value>>,
      candidateId: string,
      rating: PopuloraRating
    ) =>
      population.map((entry) =>
        entry.candidate.id === candidateId ? { ...entry, rating } : entry
      )

    const evolvePopulation = <Value>(
      step: number,
      role: PopuloraRole,
      population: ReadonlyArray<PopuloraMember<Value>>,
      knownIds: Set<string>,
      evolve: (
        context: PopuloraEvolutionContext<Value, Evidence>
      ) => Effect.Effect<
        Candidate<Value> | undefined,
        EvolutionError,
        EvolutionRequirements
      >
    ) =>
      Effect.gen(function* () {
        const ranked = [...population].sort((left, right) => {
          const difference =
            populoraConservativeScore(right.rating, ratingOptions.confidence) -
            populoraConservativeScore(left.rating, ratingOptions.confidence)
          return difference === 0
            ? left.candidate.id.localeCompare(right.candidate.id)
            : difference
        })
        const cullCount =
          population.length === 1
            ? 1
            : Math.min(
                population.length - 1,
                Math.max(1, Math.floor(population.length * options.cullFraction))
              )
        const replaced = ranked.slice(ranked.length - cullCount)
        const parentPool = population.length === 1 ? ranked : ranked.slice(0, -cullCount)
        let next = [...population]

        for (const weak of replaced) {
          const useCrossover = parentPool.length > 1 && random() < crossoverRate
          const first = parentPool[randomIndex(parentPool.length, random)]!
          const parents: Array<PopuloraMember<Value>> = [first]
          if (useCrossover) {
            const remaining = parentPool.filter((entry) => entry !== first)
            parents.push(remaining[randomIndex(remaining.length, random)]!)
          }
          const operator: PopuloraOperator = useCrossover ? "crossover" : "mutation"
          const proposed = yield* evolve({
            step,
            role,
            operator,
            replaced: weak,
            parents,
            matches: recentMatches
          })
          if (proposed === undefined) {
            evolutions.push({
              step,
              role,
              operator,
              replaced: weak.candidate.id,
              parents: parents.map((entry) => entry.candidate.id)
            })
            continue
          }
          const child = normalizeChild(proposed, parents)
          if (knownIds.has(child.id)) {
            throw new Error(`PopuLoRA ${role} id "${child.id}" already exists in its lineage`)
          }
          knownIds.add(child.id)
          const member: PopuloraMember<Value> = {
            candidate: child,
            rating: initialRating(role, child.id),
            generation: Math.max(...parents.map((entry) => entry.generation)) + 1,
            parents: parents.map((entry) => entry.candidate.id)
          }
          next = next.map((entry) => (entry === weak ? member : entry))
          evolutions.push({
            step,
            role,
            operator,
            replaced: weak.candidate.id,
            parents: member.parents,
            child: child.id
          })
        }
        return next
      })

    for (let step = 0; step < options.steps; step += 1) {
      let available = [...students]
      const pairings = teachers.map((teacher) => {
        if (available.length === 0) available = [...students]
        const weights = available.map((student) => {
          const expected = populoraWinProbability(
            student.rating,
            teacher.rating,
            ratingOptions.beta
          )
          return expected * (1 - expected)
        })
        const selected = available.splice(weightedIndex(weights, random), 1)[0]!
        return {
          teacher: teacher.candidate.id,
          student: selected.candidate.id
        }
      })

      for (const pairing of pairings) {
        const teacher = teachers.find((entry) => entry.candidate.id === pairing.teacher)!
        const student = students.find((entry) => entry.candidate.id === pairing.student)!
        const expectedStudentSolveRate = populoraWinProbability(
          student.rating,
          teacher.rating,
          ratingOptions.beta
        )
        const trials = yield* options.runMatch({ step, teacher, student })
        const rewards = populoraRewards(trials)
        const hasValidTrial = trials.some((trial) => trial.valid)
        const outcome: PopuloraMatchOutcome = !hasValidTrial
          ? "student"
          : Math.abs(rewards.solveRate - expectedStudentSolveRate) <= Number.EPSILON
            ? "draw"
            : rewards.solveRate > expectedStudentSolveRate
              ? "student"
              : "teacher"
        if (outcome === "draw") {
          const [nextTeacher, nextStudent] = rateDraw(
            teacher.rating,
            student.rating,
            ratingOptions
          )
          teachers = updateRating(teachers, teacher.candidate.id, nextTeacher)
          students = updateRating(students, student.candidate.id, nextStudent)
        } else {
          const [winner, loser] =
            outcome === "student"
              ? rateWinner(student.rating, teacher.rating, ratingOptions)
              : rateWinner(teacher.rating, student.rating, ratingOptions)
          if (outcome === "student") {
            students = updateRating(students, student.candidate.id, winner)
            teachers = updateRating(teachers, teacher.candidate.id, loser)
          } else {
            teachers = updateRating(teachers, teacher.candidate.id, winner)
            students = updateRating(students, student.candidate.id, loser)
          }
        }
        const match: PopuloraMatch<Evidence> = {
          step,
          teacher: teacher.candidate.id,
          student: student.candidate.id,
          expectedStudentSolveRate,
          outcome,
          trials,
          ...rewards
        }
        matches.push(match)
        recentMatches.push(match)
      }

      if ((step + 1) % options.evolutionInterval === 0) {
        teachers = yield* evolvePopulation(
          step,
          "teacher",
          teachers,
          teacherIds,
          options.evolveTeacher
        )
        students = yield* evolvePopulation(
          step,
          "student",
          students,
          studentIds,
          options.evolveStudent
        )
        recentMatches = []
      }
    }

    const result: PopuloraResult<Teacher, Student, Evidence> = {
      teachers,
      students,
      matches,
      evolutions
    }
    return result
  })
}
