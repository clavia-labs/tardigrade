// Reflective mutation: the half of GEPA that learns.
//
// The loop in `./gepa` decides which candidate to spend the next rollout on. This file decides what
// the rollout teaches. A proposer reads one instruction, the tasks the candidate carried it into,
// the answers it gave, and the evaluator's sentences about those answers, then writes a replacement
// instruction. Selection without this is a sampler over hand-written edits, and it is the reflection
// that makes the search sample-efficient, so this is the mutation the loop is meant to run.
//
// The proposer is an agent. It gets a private session, an output contract that rejects a malformed
// proposal back to the model, a tool budget, and an event log. The log is the point: the same cost
// projections that price an evaluation price the reflection, so the search reports what it spent on
// thinking about itself.

import { Effect, Schema } from "effect"
import type { Event, EventLog } from "@flamecast/core"
import {
  createAgent,
  defaultPack,
  jsonSchemaOf,
  type AgentServices,
  type BranchOptions,
  type InboundMessage,
  type Instruction,
  type TurnResult
} from "@flamecast/harness"
import type { InferenceSelection, NativeTool } from "@flamecast/harness/infer"
import type { InferenceOptions } from "@flamecast/harness/modules/inference"
import { candidate, type Candidate } from "./candidate"
import { costed } from "./cost"
import type { GepaEvaluation, GepaMutationContext, GepaProposal } from "./gepa"
import { scoreOf, verdictsOf } from "./score"

// The paper's feedback function over a Flamework log.
//
// An evaluation metric already produces text on its way to a number: graders write reasons, a turn
// that fails states why. Those sentences are the diagnosis, and dropping them to keep the number is
// the loss this reads back.
const terminalOf = (log: ReadonlyArray<Event>): Event | undefined => {
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event?.type === "TurnCompleted" || event?.type === "TurnFailed") return event
  }
  return undefined
}

const failureOf = (log: ReadonlyArray<Event>): string | undefined => {
  const terminal = terminalOf(log)
  return terminal?.type === "TurnFailed"
    ? `the turn failed: ${String(terminal.error ?? "")}`
    : undefined
}

// What the candidate answered, or the empty string while a turn is still open.
export const outputOf = (log: ReadonlyArray<Event>): string => {
  const terminal = terminalOf(log)
  return terminal?.type === "TurnCompleted" ? String(terminal.output ?? "") : ""
}

// Why the candidate scored what it did: every graded reason in log order, then the failure that
// ended the turn when one did.
export const feedbackOf = (log: ReadonlyArray<Event>): string => {
  const graded = verdictsOf(log)
    .filter((verdict) => verdict.reason !== "")
    .map((verdict) => `scored ${verdict.score}: ${verdict.reason}`)
  const failure = failureOf(log)
  return [...graded, ...(failure === undefined ? [] : [failure])].join("\n")
}

// One evaluation, read off the log the candidate wrote. This is the shortest correct thing to return
// from `evaluate`, and it carries the feedback rather than dropping it.
export const evaluationOf = (log: ReadonlyArray<Event>) =>
  ({
    score: scoreOf(log),
    feedback: feedbackOf(log),
    output: outputOf(log),
    trajectory: log
  }) satisfies GepaEvaluation<ReadonlyArray<Event>>

export interface ReflectionTrial {
  readonly input: string
  readonly output: string
  readonly feedback: string
  readonly score: number
}

export interface Reflection {
  // The instruction under revision. One per reflection, so credit lands somewhere specific.
  readonly instruction: Instruction
  readonly trials: ReadonlyArray<ReflectionTrial>
  // The rest of the candidate's instructions. They stay as they are, and naming them stops the
  // proposer from writing a replacement that repeats or contradicts what another module says.
  readonly siblings: ReadonlyArray<Instruction>
}

const block = (text: string): string => `\`\`\`\n${text}\n\`\`\``

const trialText = (trial: ReflectionTrial, index: number): string =>
  [
    `## Example ${index + 1}`,
    "",
    "Input:",
    trial.input,
    "",
    ...(trial.output === "" ? [] : ["Response:", trial.output, ""]),
    `Score: ${trial.score}`,
    ...(trial.feedback === ""
      ? ["Feedback: the evaluator reported this score with no further detail."]
      : ["Feedback:", trial.feedback])
  ].join("\n")

// GEPA's reflection and prompt update meta-prompt, as Appendix B of the paper states it, with the
// instruction under revision named so a multi-instruction agent knows which one is being replaced.
export const reflectionPrompt = (reflection: Reflection): string =>
  [
    `I provided an assistant with the following instructions, named "${reflection.instruction.id}", to perform a task for me:`,
    "",
    block(reflection.instruction.text),
    "",
    "The following are examples of different task inputs provided to the assistant along with the assistant's response for each of them, and some feedback on how the assistant's response could be better:",
    "",
    block(reflection.trials.map(trialText).join("\n\n")),
    ...(reflection.siblings.length === 0
      ? []
      : [
          "",
          "The assistant also carries the following instructions, which stay exactly as they are. Write for an assistant that reads all of them together:",
          "",
          block(
            reflection.siblings
              .map((sibling) => `## ${sibling.id}\n${sibling.text}`)
              .join("\n\n")
          )
        ]),
    "",
    `Your task is to write a new instruction for the assistant, replacing the one named "${reflection.instruction.id}".`,
    "",
    "Read the inputs carefully and identify the input format and infer a detailed task description about the task I wish to solve with the assistant.",
    "",
    "Read all the assistant responses and the corresponding feedback. Identify all niche and domain specific factual information about the task and include it in the instruction, as a lot of it may not be available to the assistant in the future. The assistant may have utilized a generalizable strategy to solve the task, if so, include that in the instruction as well.",
    "",
    "Answer with the complete replacement text. The assistant reads the instruction you write and nothing else from this conversation."
  ].join("\n")

const PROPOSER_SYSTEM =
  "You rewrite the instructions that drive another assistant. Each turn gives you one of that " +
  "assistant's instructions, the tasks it was given while carrying that instruction, the answers " +
  "it produced, and the evaluator's feedback on those answers. Work out which parts of the " +
  "instruction earned the good answers and which omission or phrasing caused the bad ones, then " +
  "write a replacement for that one instruction. Keep the wording that is working, repair what the " +
  "feedback names, and carry any domain fact the answers needed into the text, because the " +
  "assistant reads your instruction with none of this evidence in front of it."

// A proposal is one instruction, so the contract asks for one string and rejects anything else back
// to the model before it reaches the search.
const PROPOSAL = Schema.Struct({
  instruction: Schema.String.annotate({
    description:
      "The complete replacement text for the named instruction. Write the instruction itself, not a description of how it changed."
  })
})

const PROPOSAL_SCHEMA = jsonSchemaOf(PROPOSAL)

interface ProposerSettings<R = never> {
  readonly system?: string
  readonly nativeTools?: ReadonlyArray<NativeTool<R>>
}

// A proposer answers with a model, so it says which model, the same way every other module does.
export type ProposerOptions<R = never> =
  | (ProposerSettings<R> & {
      readonly provider: InferenceSelection
      readonly contextWindow?: number
    })
  | (ProposerSettings<R> & {
      readonly provider?: InferenceSelection
      readonly contextWindow: number
    })

const proposerInference = <R>(options: ProposerOptions<R>): InferenceOptions => {
  const system = options.system ?? PROPOSER_SYSTEM
  if (options.provider !== undefined) return { system, provider: options.provider }
  if (options.contextWindow === undefined) {
    throw new Error(
      "proposer() needs a provider or a contextWindow: reflection answers with a model, so it has " +
        "to say which model and what it accepts."
    )
  }
  return { system, contextWindow: options.contextWindow }
}

// The agent that reflects. It is an ordinary Flamework agent, so a caller who wants the proposer to
// read the repository before it rewrites an instruction adds tools, and a caller who wants a
// stronger model than the one under optimization names a provider.
export const proposer = <R = never>(options: ProposerOptions<R>) =>
  createAgent({
    modules: defaultPack<R>({
      inference: proposerInference(options),
      ...(options.nativeTools === undefined ? {} : { nativeTools: options.nativeTools })
    })
  })

const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value)

// The proposal, lifted out of the turn's output. The contract already checked it against the schema,
// so a value that fails here is a turn that ended some other way.
const instructionIn = (output: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(output)
    if (parsed === null || typeof parsed !== "object") return undefined
    const held = (parsed as { readonly instruction?: unknown }).instruction
    return typeof held === "string" ? held : undefined
  } catch {
    return undefined
  }
}

// What a reflection needs from the agent that proposes: a session of its own, one turn, and the log
// that turn wrote. An agent satisfies this whatever services its own modules provide, so a caller
// hands over the agent they built rather than one this file dictates the shape of.
export interface ProposerSession<R> {
  readonly turn: (message: InboundMessage) => Effect.Effect<TurnResult, never, R | AgentServices>
  readonly log: Effect.Effect<ReadonlyArray<Event>, never, EventLog>
}

export interface Proposer<R = never> {
  readonly branch: (
    recorded: ReadonlyArray<Event>,
    options?: BranchOptions
  ) => ProposerSession<R>
}

export interface ReflectiveMutationOptions<
  Value,
  Example,
  Evaluation extends GepaEvaluation,
  R = never
> {
  // The agent that reflects. Required, because reflection answers with a model and the search has no
  // way to pick one: `proposer({ contextWindow })` builds the default, and any agent will do.
  readonly proposer: Proposer<R>
  // The instructions a candidate exposes for rewriting, in a stable order. Round-robin selection
  // walks this list, so every instruction gets its turn.
  readonly instructionsOf: (value: Value) => ReadonlyArray<Instruction>
  // The candidate that carries the rewritten instruction, or undefined when it cannot be built. A
  // caller that compiles generated code returns undefined for a construction that fails, and the
  // loop records the proposal cost without spending evaluation budget on it.
  readonly apply: (
    rewritten: Instruction,
    context: GepaMutationContext<Value, Example, Evaluation>
  ) => Candidate<Value> | undefined
  readonly renderExample?: (example: Example) => string
  readonly selectTarget?: (
    targets: ReadonlyArray<Instruction>,
    context: GepaMutationContext<Value, Example, Evaluation>
  ) => Instruction | undefined
  readonly budget?: number
}

const proposed = <Value>(built: Candidate<Value>): GepaProposal<Value> => ({
  kind: "proposed",
  candidate: built
})

const declined = (reason: string): GepaProposal<never> => ({ kind: "declined", reason })

const failedProposal = (error: string): GepaProposal<never> => ({ kind: "failed", error })

// Why the reflection turn did not answer, in the words the turn itself recorded.
const reflectionFailure = (result: TurnResult): string => {
  if (result.kind === "failed") return `the proposer turn failed: ${result.error}`
  if (result.kind === "parked") {
    return `the proposer turn parked asking for more budget: ${result.reason}`
  }
  return "the proposer turn did not finish"
}

// Round robin over the candidate's instructions, which is what the paper selects modules with: every
// instruction receives updates rather than the search pouring its budget into whichever one it
// touched first.
const roundRobin = <Value, Example, Evaluation extends GepaEvaluation>(
  targets: ReadonlyArray<Instruction>,
  context: GepaMutationContext<Value, Example, Evaluation>
): Instruction | undefined => targets[context.iteration % targets.length]

export const reflectiveMutation = <
  Value,
  Example,
  Evaluation extends GepaEvaluation,
  R = never
>(
  options: ReflectiveMutationOptions<Value, Example, Evaluation, R>
) => {
  // Read once. Reaching through the options on every iteration would say the proposer could change
  // between them, and it can not.
  const reflector = options.proposer
  const render = options.renderExample ?? textOf
  const select = options.selectTarget ?? roundRobin
  return (context: GepaMutationContext<Value, Example, Evaluation>) =>
    Effect.gen(function* () {
      const targets = options.instructionsOf(context.parent.value)
      if (targets.length === 0) {
        return costed(declined("the candidate exposes no instruction to rewrite"))
      }
      const target = select(targets, context)
      if (target === undefined) return costed(declined("no instruction was selected to rewrite"))
      const prompt = reflectionPrompt({
        instruction: target,
        trials: context.trials.map((trial) => ({
          input: render(trial.example.value),
          output: trial.evaluation.output ?? "",
          feedback: trial.evaluation.feedback,
          score: trial.evaluation.score
        })),
        siblings: targets.filter((instruction) => instruction.id !== target.id)
      })
      // Each reflection runs in its own session. The proposer holds no memory of earlier iterations,
      // which is what keeps a candidate's lineage the only thing carrying lessons forward, and its
      // log stays a clean span to price.
      const session = reflector.branch([], {
        id: `reflect:${context.parent.id}:${context.iteration}`
      })
      const result = yield* session.turn({
        id: `reflect-${context.iteration}`,
        text: prompt,
        output: PROPOSAL_SCHEMA,
        ...(options.budget === undefined ? {} : { budget: options.budget })
      })
      const log = yield* session.log
      // A turn that did not complete is the proposer breaking, which is a different fact from the
      // proposer declining. The reflection never ran, so reading it as "nothing better to offer"
      // would spend the rest of the budget re-learning that the transport is down.
      if (result.kind !== "completed") {
        return costed(failedProposal(reflectionFailure(result)), log)
      }
      const rewritten = instructionIn(result.output)
      if (rewritten === undefined) {
        return costed(
          failedProposal("the proposer completed without answering through the contract"),
          log
        )
      }
      // A proposer that answers with the instruction it was given has proposed nothing. Evaluating
      // it would spend a minibatch to learn that a candidate ties itself.
      if (rewritten.trim() === "" || rewritten === target.text) {
        return costed(declined(`the proposer left "${target.id}" as it was`), log)
      }
      const built = options.apply({ id: target.id, text: rewritten }, context)
      return costed(
        built === undefined
          ? declined(`the rewritten "${target.id}" did not build a candidate`)
          : proposed(built),
        log
      )
    })
}

// A candidate that is exactly its instruction texts, keyed by instruction id. This is what GEPA
// optimizes in the paper, and it is the shortest candidate to evolve: `evaluate` builds an agent
// from the texts and runs it, and nothing else has to be written.
export type Prompts = Readonly<Record<string, string>>

export const reflectivePrompts = <Example, Evaluation extends GepaEvaluation, R = never>(
  options: Omit<
    ReflectiveMutationOptions<Prompts, Example, Evaluation, R>,
    "instructionsOf" | "apply"
  >
) =>
  reflectiveMutation<Prompts, Example, Evaluation, R>({
    ...options,
    instructionsOf: (value) => Object.entries(value).map(([id, text]) => ({ id, text })),
    // The id names the iteration that proposed it, so two reflections that converge on the same text
    // stay two candidates and the loop never meets an id its population already holds.
    apply: (rewritten, context) =>
      candidate(
        `reflect:${context.iteration}:${rewritten.id}`,
        { ...context.parent.value, [rewritten.id]: rewritten.text },
        { parent: context.parent.id }
      )
  })
