import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Event } from "@flamecast/core"
import {
  inferWith,
  keyOf,
  type Action,
  type AgentServices,
  type Infer,
  type ModelRequest
} from "@flamecast/harness"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { candidate } from "./candidate"
import { costed } from "./cost"
import { gepa, type GepaMutationContext } from "./gepa"
import {
  evaluationOf,
  feedbackOf,
  proposer,
  reflectionPrompt,
  reflectiveMutation,
  reflectivePrompts,
  type Prompts
} from "./reflect"

// The proposer is an agent, so the test drives it the way every other agent in this repository is
// driven: a scripted model, the in-memory runtime, and the log as the record of what happened.

const usage = { promptTokens: 900, completionTokens: 60, costUsd: 0.003 }

const scripted = (actions: ReadonlyArray<Action>) => {
  const seen: Array<ModelRequest> = []
  return {
    seen,
    layer: inferWith(async (request) => {
      seen.push(request)
      const next = actions[seen.length - 1]
      if (next === undefined) throw new Error(`the stub model ran out of actions after ${seen.length}`)
      return next
    })
  }
}

const answers = (instruction: string): Action => ({
  kind: "call",
  callId: `c-${instruction.length}`,
  name: "answer",
  arguments: { instruction },
  usage
})

const run = <A>(
  program: Effect.Effect<A, never, AgentServices>,
  model: Layer.Layer<Infer>
) =>
  Effect.runPromise(
    Effect.provide(
      program,
      Layer.merge(InMemoryRuntime({ keyOf, session: "search" }), model)
    )
  )

const trial = (id: string, value: string, evaluation: {
  readonly score: number
  readonly feedback: string
  readonly output?: string
}) => ({
  example: { id, value },
  evaluation: { ...evaluation, trajectory: [] as ReadonlyArray<Event> },
  cost: { promptTokens: 0, completionTokens: 0, costUsd: 0, toolCalls: 0 }
})

const contextOf = (
  prompts: Prompts,
  iteration: number,
  trials: ReturnType<typeof trial>[]
): GepaMutationContext<Prompts, string, {
  readonly score: number
  readonly feedback: string
  readonly output?: string
  readonly trajectory: ReadonlyArray<Event>
}> => ({
  iteration,
  parent: candidate("seed", prompts),
  trials
})

describe("the feedback function over a log", () => {
  const log: ReadonlyArray<Event> = [
    { type: "MessageReceived", id: "m-1", text: "What does order 4182 owe?", at: 1 },
    { type: "TurnCompleted", turn: "m-1", output: "312.00", at: 2 },
    { type: "RewardGranted", run: "r-1", score: 0.6, reason: "quoted the total without the tax line", at: 3 },
    { type: "RewardGranted", run: "r-1", regime: "cost", score: 0.2, at: 4 }
  ]

  test("keeps the sentences the graders wrote", () => {
    expect(feedbackOf(log)).toBe("scored 0.6: quoted the total without the tax line")
  })

  test("reports a failed turn as feedback of its own", () => {
    expect(
      feedbackOf([{ type: "TurnFailed", turn: "m-1", error: "the model attempt died 3 times in a row", at: 2 }])
    ).toBe("the turn failed: the model attempt died 3 times in a row")
  })

  test("reads one evaluation off the log the candidate wrote", () => {
    expect(evaluationOf(log)).toEqual({
      score: 0.8,
      feedback: "scored 0.6: quoted the total without the tax line",
      output: "312.00",
      trajectory: log
    })
  })
})

describe("the reflection meta-prompt", () => {
  const prompt = reflectionPrompt({
    instruction: { id: "inference.system", text: "Answer the billing question." },
    trials: [
      {
        input: "What does order 4182 owe?",
        output: "312.00",
        feedback: "quoted the total without the tax line",
        score: 0.6
      }
    ],
    siblings: [{ id: "tone", text: "Write in plain English." }]
  })

  test("shows the instruction under revision by name", () => {
    expect(prompt).toContain('named "inference.system"')
    expect(prompt).toContain("Answer the billing question.")
  })

  test("shows each input, response, score, and feedback", () => {
    expect(prompt).toContain("What does order 4182 owe?")
    expect(prompt).toContain("312.00")
    expect(prompt).toContain("Score: 0.6")
    expect(prompt).toContain("quoted the total without the tax line")
  })

  test("shows the instructions that stay as they are", () => {
    expect(prompt).toContain("Write in plain English.")
    expect(prompt).toContain("which stay exactly as they are")
  })

  test("asks for the replacement instruction the paper asks for", () => {
    expect(prompt).toContain("Your task is to write a new instruction for the assistant")
    expect(prompt).toContain("niche and domain specific factual information")
  })
})

describe("the reflective mutation", () => {
  const prompts: Prompts = {
    "inference.system": "Answer the billing question.",
    tone: "Write in plain English."
  }

  test("runs the proposer as a session and returns its rewritten candidate", async () => {
    const model = scripted([answers("Answer the billing question. Always state the tax line.")])
    const mutate = reflectivePrompts({ proposer: proposer() })

    const result = await run(
      mutate(
        contextOf(prompts, 0, [
          trial("f1", "What does order 4182 owe?", {
            score: 0.6,
            feedback: "quoted the total without the tax line",
            output: "312.00"
          })
        ])
      ),
      model.layer
    )

    expect(result.value?.value).toEqual({
      "inference.system": "Answer the billing question. Always state the tax line.",
      tone: "Write in plain English."
    })
    expect(result.value?.parent).toBe("seed")
    // The proposer is an agent, so what it spent is priced from its own log by the same projection
    // that prices an evaluation.
    expect(result.cost).toEqual({
      promptTokens: 900,
      completionTokens: 60,
      costUsd: 0.003,
      toolCalls: 0
    })
    // What the model actually read: the meta-prompt, carrying the evidence from the trials.
    expect(model.seen[0]?.messages[0]?.content).toContain("quoted the total without the tax line")
    expect(model.seen[0]?.messages[0]?.content).toContain("Answer the billing question.")
    // The proposal arrives through the contract, so a malformed one is rejected before the search
    // sees it.
    expect(model.seen[0]?.tools?.map((tool) => tool.name)).toContain("answer")
  })

  test("walks the instructions in round robin so each one gets its turn", async () => {
    const targets: Array<string> = []
    const model = scripted([answers("first rewrite"), answers("second rewrite")])
    const mutate = reflectivePrompts({
      proposer: proposer(),
      selectTarget: (available, context) => {
        const target = available[context.iteration % available.length]
        targets.push(target?.id ?? "")
        return target
      }
    })
    const trials = [trial("f1", "a question", { score: 0, feedback: "wrong" })]

    const first = await run(mutate(contextOf(prompts, 0, trials)), model.layer)
    const second = await run(mutate(contextOf(prompts, 1, trials)), model.layer)

    expect(targets).toEqual(["inference.system", "tone"])
    expect(first.value?.value["inference.system"]).toBe("first rewrite")
    expect(second.value?.value.tone).toBe("second rewrite")
  })

  test("selects by round robin without being told to", async () => {
    const model = scripted([answers("a rewrite of the tone")])
    const mutate = reflectivePrompts({ proposer: proposer() })

    const result = await run(
      mutate(contextOf(prompts, 1, [trial("f1", "a question", { score: 0, feedback: "wrong" })])),
      model.layer
    )

    expect(result.value?.value.tone).toBe("a rewrite of the tone")
    expect(result.value?.value["inference.system"]).toBe("Answer the billing question.")
  })

  test("reflects with the default proposer when it is given none", async () => {
    // The shortest mutation that compiles has a model in it, which is the point of the default.
    const model = scripted([answers("a rewrite from the default proposer")])

    const result = await run(
      reflectivePrompts()(
        contextOf(prompts, 0, [trial("f1", "a question", { score: 0, feedback: "wrong" })])
      ),
      model.layer
    )

    expect(result.value?.value["inference.system"]).toBe("a rewrite from the default proposer")
    expect(model.seen[0]?.system).toContain("You rewrite the instructions")
  })

  test("proposes nothing when the proposer answers with the instruction it was given", async () => {
    const model = scripted([answers("Answer the billing question.")])
    const mutate = reflectivePrompts({ proposer: proposer() })

    const result = await run(
      mutate(contextOf(prompts, 0, [trial("f1", "a question", { score: 0, feedback: "wrong" })])),
      model.layer
    )

    // No candidate, and the reflection is still priced: the loop paid for the thinking.
    expect(result.value).toBeUndefined()
    expect(result.cost.completionTokens).toBe(60)
  })

  test("proposes nothing when the proposer turn fails", async () => {
    const model = scripted([{ kind: "fail", error: "the provider refused", usage }])
    const mutate = reflectivePrompts({ proposer: proposer() })

    const result = await run(
      mutate(contextOf(prompts, 0, [trial("f1", "a question", { score: 0, feedback: "wrong" })])),
      model.layer
    )

    expect(result.value).toBeUndefined()
    expect(result.cost.promptTokens).toBe(900)
  })

  test("proposes nothing when a candidate exposes no instruction", async () => {
    const model = scripted([])
    const mutate = reflectivePrompts({ proposer: proposer() })

    const result = await run(
      mutate(contextOf({}, 0, [trial("f1", "a question", { score: 0, feedback: "wrong" })])),
      model.layer
    )

    expect(result.value).toBeUndefined()
    expect(model.seen).toEqual([])
  })

  test("renders a structured example with the caller's renderer", async () => {
    const model = scripted([answers("a rewrite")])
    const mutate = reflectiveMutation<Prompts, { readonly order: string }, {
      readonly score: number
      readonly feedback: string
      readonly trajectory: ReadonlyArray<Event>
    }>({
      proposer: proposer(),
      instructionsOf: (value) => Object.entries(value).map(([id, text]) => ({ id, text })),
      apply: (rewritten, context) =>
        candidate("child", { ...context.parent.value, [rewritten.id]: rewritten.text }),
      renderExample: (example) => `order ${example.order}`
    })

    await run(
      mutate({
        iteration: 0,
        parent: candidate("seed", prompts),
        trials: [
          {
            example: { id: "f1", value: { order: "4182" } },
            evaluation: { score: 0, feedback: "wrong", trajectory: [] },
            cost: { promptTokens: 0, completionTokens: 0, costUsd: 0, toolCalls: 0 }
          }
        ]
      }),
      model.layer
    )

    expect(model.seen[0]?.messages[0]?.content).toContain("order 4182")
  })
})

describe("GEPA driven by reflection", () => {
  // The whole loop with a model in it: the evaluator scores a prompt set, the proposer reads the
  // feedback, and the loop keeps the rewrite that scores better on the minibatch.
  const scores: Readonly<Record<string, Readonly<Record<string, number>>>> = {
    "Answer the billing question.": { f1: 0.2, p1: 0.3 },
    "Answer the billing question. Always state the tax line.": { f1: 0.9, p1: 0.8 }
  }

  const evaluate = (entry: { readonly value: Prompts }, example: { readonly id: string }) =>
    Effect.succeed(
      costed({
        score: scores[entry.value["inference.system"] ?? ""]?.[example.id] ?? 0,
        feedback: "quoted the total without the tax line",
        output: "312.00",
        trajectory: [] as ReadonlyArray<Event>
      })
    )

  test("accepts the rewrite the proposer wrote", async () => {
    const model = scripted([answers("Answer the billing question. Always state the tax line.")])

    const result = await run(
      gepa({
        seed: candidate<Prompts>("v0", { "inference.system": "Answer the billing question." }),
        feedbackExamples: [{ id: "f1", value: "What does order 4182 owe?" }],
        paretoExamples: [{ id: "p1", value: "What does order 5501 owe?" }],
        minibatchSize: 1,
        maxMetricCalls: 4,
        evaluate,
        mutate: reflectivePrompts({ proposer: proposer() })
      }),
      model.layer
    )

    expect(result.best.candidate.id).toBe("reflect:0:inference.system")
    expect(result.best.candidate.value).toEqual({
      "inference.system": "Answer the billing question. Always state the tax line."
    })
    expect(result.iterations[0]).toMatchObject({ accepted: true, parent: "v0" })
    // The reflection is inside the search's cost, so a run reports what it spent on proposing.
    expect(result.cost.completionTokens).toBe(60)
  })
})
