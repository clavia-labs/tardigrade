import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { candidate } from "./candidate"
import {
  populora,
  populoraConservativeScore,
  populoraRewards,
  populoraWinProbability,
  type PopuloraTrial
} from "./populora"

const trial = <Evidence>(
  valid: boolean,
  outcomes: PopuloraTrial<Evidence>["outcomes"],
  evidence: Evidence
): PopuloraTrial<Evidence> => ({ valid, outcomes, evidence })

const noEvolution = () => Effect.succeed(undefined)

describe("PopuLoRA rewards and ratings", () => {
  test("implements the verifier reward equations", () => {
    const rewards = populoraRewards([
      trial(false, [], "invalid problem"),
      trial(true, ["correct", "incorrect", "format-error"], "valid problem")
    ])

    expect(rewards.teacherReward).toBeCloseTo(-1 / 6, 10)
    expect(rewards.studentReward).toBeCloseTo(-1 / 6, 10)
    expect(rewards.solveRate).toBeCloseTo(1 / 3, 10)
  })

  test("gives an impossible valid problem zero teacher reward", () => {
    expect(populoraRewards([trial(true, ["incorrect", "format-error"], null)])).toEqual({
      teacherReward: 0,
      studentReward: -0.75,
      solveRate: 0
    })
  })

  test("predicts balanced matches and ranks by the lower confidence bound", () => {
    expect(
      populoraWinProbability(
        { mu: 25, sigma: 25 / 3 },
        { mu: 25, sigma: 25 / 3 }
      )
    ).toBeCloseTo(0.5, 6)
    expect(populoraConservativeScore({ mu: 25, sigma: 5 }, 3)).toBe(10)
  })
})

describe("the PopuLoRA loop", () => {
  test("cross-evaluates matched harnesses and updates their TrueSkill ratings", async () => {
    const teacher = candidate("teacher", { role: "teacher" })
    const student = candidate("student", { role: "student" })
    const result = await Effect.runPromise(
      populora({
        teachers: [teacher],
        students: [student],
        steps: 1,
        evolutionInterval: 10,
        cullFraction: 0.25,
        runMatch: () =>
          Effect.succeed([
            trial(false, [], "invalid problem"),
            trial(true, ["correct", "incorrect", "format-error"], "valid problem")
          ]),
        evolveTeacher: noEvolution,
        evolveStudent: noEvolution
      })
    )

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      step: 0,
      teacher: "teacher",
      student: "student",
      outcome: "teacher"
    })
    expect(result.matches[0]?.teacherReward).toBeCloseTo(-1 / 6, 10)
    expect(result.matches[0]?.studentReward).toBeCloseTo(-1 / 6, 10)
    expect(result.matches[0]?.solveRate).toBeCloseTo(1 / 3, 10)
    expect(result.matches[0]?.trials[1]?.evidence).toBe("valid problem")
    expect(result.teachers[0]?.rating.mu).toBeCloseTo(29.396, 3)
    expect(result.students[0]?.rating.mu).toBeCloseTo(20.604, 3)
    expect(result.teachers[0]?.rating.sigma).toBeLessThan(25 / 3)
  })

  test("uses PFSP to prefer the near-balanced student", async () => {
    const result = await Effect.runPromise(
      populora({
        teachers: [candidate("teacher", "teacher")],
        students: [candidate("balanced", "balanced"), candidate("mismatch", "mismatch")],
        steps: 1,
        evolutionInterval: 10,
        cullFraction: 0.25,
        random: () => 0.99,
        initialRating: (role, id) =>
          role === "student" && id === "mismatch"
            ? { mu: 100, sigma: 1 }
            : { mu: 25, sigma: 1 },
        runMatch: () => Effect.succeed([trial(true, ["correct"], null)]),
        evolveTeacher: noEvolution,
        evolveStudent: noEvolution
      })
    )

    expect(result.matches[0]?.student).toBe("balanced")
  })

  test("updates uncertainty after an expected draw", async () => {
    const result = await Effect.runPromise(
      populora({
        teachers: [candidate("teacher", "teacher")],
        students: [candidate("student", "student")],
        steps: 1,
        evolutionInterval: 10,
        cullFraction: 0.25,
        runMatch: () => Effect.succeed([trial(true, ["correct", "incorrect"], null)]),
        evolveTeacher: noEvolution,
        evolveStudent: noEvolution
      })
    )

    expect(result.matches[0]?.outcome).toBe("draw")
    expect(result.teachers[0]?.rating.mu).toBeCloseTo(25, 10)
    expect(result.students[0]?.rating.mu).toBeCloseTo(25, 10)
    expect(result.teachers[0]?.rating.sigma).toBeLessThan(25 / 3)
    expect(result.students[0]?.rating.sigma).toBeLessThan(25 / 3)
  })

  test("uses a repeated student's latest rating", async () => {
    const result = await Effect.runPromise(
      populora({
        teachers: [candidate("teacher-one", "one"), candidate("teacher-two", "two")],
        students: [candidate("student", "student")],
        steps: 1,
        evolutionInterval: 10,
        cullFraction: 0.25,
        runMatch: () => Effect.succeed([trial(true, ["correct"], null)]),
        evolveTeacher: noEvolution,
        evolveStudent: noEvolution
      })
    )

    expect(result.matches.map((match) => match.student)).toEqual(["student", "student"])
    expect(result.matches[0]?.expectedStudentSolveRate).toBe(0.5)
    expect(result.matches[1]?.expectedStudentSolveRate).toBeGreaterThan(0.5)
  })

  test("replaces the weakest members with whole-harness crossovers", async () => {
    const teacherContexts: Array<{
      readonly replaced: string
      readonly parents: ReadonlyArray<string>
      readonly matches: number
    }> = []
    const studentContexts: typeof teacherContexts = []
    const seeds = (role: string) =>
      ["top", "second", "third", "bottom"].map((rank) =>
        candidate(`${role}-${rank}`, { role, rank })
      )
    const initialRating = (_role: string, id: string) => ({
      mu: id.endsWith("child")
        ? 25
        : id.endsWith("top")
          ? 100
          : id.endsWith("second")
            ? 80
            : id.endsWith("third")
              ? 60
              : -100,
      sigma: id.endsWith("child") ? 25 / 3 : 1
    })

    const result = await Effect.runPromise(
      populora({
        teachers: seeds("teacher"),
        students: seeds("student"),
        steps: 1,
        evolutionInterval: 1,
        cullFraction: 0.25,
        crossoverRate: 1,
        random: () => 0.5,
        initialRating,
        runMatch: ({ teacher, student }) =>
          Effect.succeed([
            trial(true, ["correct"], `${teacher.candidate.id}:${student.candidate.id}`)
          ]),
        evolveTeacher: (context) => {
          teacherContexts.push({
            replaced: context.replaced.candidate.id,
            parents: context.parents.map((entry) => entry.candidate.id),
            matches: context.matches.length
          })
          expect(context.operator).toBe("crossover")
          return Effect.succeed(candidate("teacher-child", { role: "teacher", rank: "child" }))
        },
        evolveStudent: (context) => {
          studentContexts.push({
            replaced: context.replaced.candidate.id,
            parents: context.parents.map((entry) => entry.candidate.id),
            matches: context.matches.length
          })
          expect(context.operator).toBe("crossover")
          return Effect.succeed(candidate("student-child", { role: "student", rank: "child" }))
        }
      })
    )

    expect(teacherContexts).toEqual([
      {
        replaced: "teacher-bottom",
        parents: ["teacher-second", "teacher-third"],
        matches: 4
      }
    ])
    expect(studentContexts).toEqual([
      {
        replaced: "student-bottom",
        parents: ["student-second", "student-third"],
        matches: 4
      }
    ])
    expect(result.teachers.map((entry) => entry.candidate.id)).toContain("teacher-child")
    expect(result.students.map((entry) => entry.candidate.id)).toContain("student-child")
    const child = result.teachers.find((entry) => entry.candidate.id === "teacher-child")!
    expect(child.candidate.parent).toBe("teacher-second")
    expect(child.parents).toEqual(["teacher-second", "teacher-third"])
    expect(child.generation).toBe(1)
    expect(child.rating).toEqual({ mu: 25, sigma: 25 / 3 })
    expect(result.evolutions).toHaveLength(2)
  })

  test("uses mutation when a role has one population member", async () => {
    const operators: Array<string> = []
    const result = await Effect.runPromise(
      populora({
        teachers: [candidate("teacher", "teacher")],
        students: [candidate("student", "student")],
        steps: 1,
        evolutionInterval: 1,
        cullFraction: 1,
        crossoverRate: 1,
        runMatch: () => Effect.succeed([trial(true, ["correct"], null)]),
        evolveTeacher: (context) => {
          operators.push(context.operator)
          return Effect.succeed(candidate("teacher-child", "teacher-child"))
        },
        evolveStudent: (context) => {
          operators.push(context.operator)
          return Effect.succeed(candidate("student-child", "student-child"))
        }
      })
    )

    expect(operators).toEqual(["mutation", "mutation"])
    expect(result.teachers[0]?.parents).toEqual(["teacher"])
    expect(result.students[0]?.parents).toEqual(["student"])
  })

  test("rejects verifier output that violates a trial invariant", async () => {
    const run = Effect.runPromise(
      populora({
        teachers: [candidate("teacher", "teacher")],
        students: [candidate("student", "student")],
        steps: 1,
        evolutionInterval: 2,
        cullFraction: 0.25,
        runMatch: () => Effect.succeed([trial(false, ["correct"], null)]),
        evolveTeacher: noEvolution,
        evolveStudent: noEvolution
      })
    )

    expect(run).rejects.toThrow("PopuLoRA invalid trials cannot contain student outcomes")
  })
})
