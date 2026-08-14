import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { candidate } from "./candidate"
import { gepa, type GepaEvaluation } from "./gepa"

interface Harness {
  readonly scores: Readonly<Record<string, number>>
  readonly source: string
}

const example = (id: string) => ({ id, value: id })

const evaluate = (evaluated: { readonly value: Harness }, task: { readonly id: string }) =>
  Effect.succeed({
    score: evaluated.value.scores[task.id] ?? 0,
    trajectory: `${evaluated.value.source}:${task.id}`
  })

describe("the GEPA loop", () => {
  test("returns the seed after its required Pareto evaluation", async () => {
    const seed = candidate("seed", { source: "seed.ts", scores: { p1: 0.4, p2: 0.8 } })
    const result = await Effect.runPromise(
      gepa({
        seed,
        feedbackExamples: [example("f1")],
        paretoExamples: [example("p1"), example("p2")],
        minibatchSize: 1,
        maxMetricCalls: 2,
        evaluate,
        mutate: () => Effect.succeed(undefined)
      })
    )

    expect(result.best.candidate).toBe(seed)
    expect(result.best.scores).toEqual({ p1: 0.4, p2: 0.8 })
    expect(result.best.average).toBeCloseTo(0.6, 10)
    expect(result.metricCalls).toBe(2)
    expect(result.iterations).toEqual([])
  })

  test("accepts strict improvements and records whole-harness lineage", async () => {
    const seed = candidate("seed", {
      source: "seed.ts",
      scores: { f1: 0.2, p1: 0.4, p2: 0.4 }
    })
    const result = await Effect.runPromise(
      gepa({
        seed,
        feedbackExamples: [example("f1")],
        paretoExamples: [example("p1"), example("p2")],
        minibatchSize: 1,
        maxMetricCalls: 10,
        random: () => 0,
        evaluate,
        mutate: ({ iteration, parent, trials }) => {
          expect(trials[0]?.evaluation.trajectory).toBe(`${parent.value.source}:f1`)
          return Effect.succeed(
            iteration === 0
              ? candidate("better", {
                  source: "better.ts",
                  scores: { f1: 0.8, p1: 0.7, p2: 0.9 }
                })
              : candidate("worse", {
                  source: "worse.ts",
                  scores: { f1: 0.1, p1: 1, p2: 1 }
                })
          )
        }
      })
    )

    expect(result.population.map((entry) => entry.candidate.id)).toEqual(["seed", "better"])
    expect(result.population[1]?.candidate.parent).toBe("seed")
    expect(result.best.candidate.id).toBe("better")
    expect(result.iterations).toEqual([
      {
        iteration: 0,
        parent: "seed",
        batch: ["f1"],
        parentAverage: 0.2,
        proposal: "better",
        proposalAverage: 0.8,
        accepted: true
      },
      {
        iteration: 1,
        parent: "better",
        batch: ["f1"],
        parentAverage: 0.8,
        proposal: "worse",
        proposalAverage: 0.1,
        accepted: false
      }
    ])
    expect(result.metricCalls).toBe(8)
  })

  test("samples from instance-wise leaders with their leadership frequency", async () => {
    const parents: Array<string> = []
    const seed = candidate("left", {
      source: "left.ts",
      scores: { feedback: 0, left: 1, middle: 1, right: 0 }
    })
    const random = [0, 0, 0.6, 0]
    const result = await Effect.runPromise(
      gepa({
        seed,
        feedbackExamples: [example("feedback")],
        paretoExamples: [example("left"), example("middle"), example("right")],
        minibatchSize: 1,
        maxMetricCalls: 13,
        random: () => random.shift() ?? 0,
        evaluate,
        mutate: ({ iteration, parent }) => {
          parents.push(parent.id)
          return Effect.succeed(
            iteration === 0
              ? candidate("right", {
                  source: "right.ts",
                  scores: { feedback: 1, left: 0, middle: 0, right: 1 }
                })
              : candidate("discarded", {
                  source: "discarded.ts",
                  scores: { feedback: -1, left: 1, middle: 1, right: 1 }
                })
          )
        }
      })
    )

    expect(parents).toEqual(["left", "left"])
    expect(result.front.map((entry) => entry.candidate.id)).toEqual(["left", "right"])
    expect(result.metricCalls).toBe(10)
  })

  test("passes evaluator-specific feedback to the mutation", async () => {
    interface FeedbackEvaluation extends GepaEvaluation<string> {
      readonly reason: string
    }

    const seen: Array<FeedbackEvaluation> = []
    const seed: Harness = { source: "seed.ts", scores: { f1: 0, p1: 0 } }
    await Effect.runPromise(
      gepa({
        seed: candidate("seed", seed),
        feedbackExamples: [example("f1")],
        paretoExamples: [example("p1")],
        minibatchSize: 1,
        maxMetricCalls: 4,
        evaluate: (evaluated, task) =>
          Effect.succeed({
            score: evaluated.value.scores[task.id] ?? 0,
            trajectory: `${evaluated.id}:${task.id}`,
            reason: "the harness chose the wrong tool"
          }),
        mutate: ({ trials }) => {
          seen.push(...trials.map((trial) => trial.evaluation))
          return Effect.succeed(undefined)
        }
      })
    )

    expect(seen).toEqual([
      {
        score: 0,
        trajectory: "seed:f1",
        reason: "the harness chose the wrong tool"
      }
    ])
  })

  test("requires mutations to preserve the selected parent", async () => {
    const run = Effect.runPromise(
      gepa({
        seed: candidate("seed", { source: "seed.ts", scores: { f1: 0, p1: 0 } }),
        feedbackExamples: [example("f1")],
        paretoExamples: [example("p1")],
        minibatchSize: 1,
        maxMetricCalls: 4,
        evaluate,
        mutate: () =>
          Effect.succeed(
            candidate(
              "child",
              { source: "child.ts", scores: { f1: 1, p1: 1 } },
              { parent: "someone-else" }
            )
          )
      })
    )

    expect(run).rejects.toThrow('GEPA proposal "child" names parent "someone-else" instead of "seed"')
  })
})
