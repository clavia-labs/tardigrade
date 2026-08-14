export type Scores = Readonly<Record<string, number>>

export interface Identified {
  readonly id: string
}

export interface ParetoArchive<Value extends Identified> {
  readonly add: (value: Value, scores: Scores) => ParetoArchive<Value>
  readonly front: ReadonlyArray<Value>
  readonly sample: (rng: () => number) => Value | undefined
}

interface Entry<Value> {
  readonly value: Value
  readonly scores: Scores
}

const scoreAt = (scores: Scores, task: string): number =>
  scores[task] ?? Number.NEGATIVE_INFINITY

const dominates = (left: Scores, right: Scores, tasks: ReadonlyArray<string>): boolean => {
  let strictly = false
  for (const task of tasks) {
    const here = scoreAt(left, task)
    const there = scoreAt(right, task)
    if (here < there) return false
    if (here > there) strictly = true
  }
  return strictly
}

const build = <Value extends Identified>(
  entries: ReadonlyArray<Entry<Value>>
): ParetoArchive<Value> => {
  const tasks = [...new Set(entries.flatMap((entry) => Object.keys(entry.scores)))]
  const front = entries
    .filter(
      (entry) =>
        !entries.some(
          (other) => other !== entry && dominates(other.scores, entry.scores, tasks)
        )
    )
    .map((entry) => entry.value)
  return {
    add: (value, scores) =>
      build([...entries.filter((entry) => entry.value.id !== value.id), { value, scores }]),
    front,
    sample: (rng) =>
      front.length === 0
        ? undefined
        : front[Math.min(front.length - 1, Math.floor(rng() * front.length))]
  }
}

export const paretoArchive = <Value extends Identified>(): ParetoArchive<Value> => build([])
