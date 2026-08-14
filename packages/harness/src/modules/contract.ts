import { erase, machine, type Event } from "@flamecast/core"
import { ANSWER } from "../exits"
import type { NativeToolSpec } from "../infer"
import { defineModule } from "../module"
import type { Nudge } from "../program"
import { answerErrors, repairText } from "../schema"
import { turnHead, turnOf, turnView } from "../turns"

// The contract module: a turn that declares an output schema answers through the `answer` tool, and
// its arguments are checked before they become the final answer.
//
// A rejection returns to the model as a tool result, so the model reads its own errors and repairs
// the shape. The inference module's retry options bound how long that can go on.

// The turn head stores the declared schema. A turn with no schema answers in prose while this
// module rests.
const outputSchemaOf = (log: ReadonlyArray<Event>): unknown => turnHead(turnView(log))?.output

const declaresOutput = (log: ReadonlyArray<Event>): boolean => outputSchemaOf(log) !== undefined

const ANSWER_TEXT =
  "This turn declares an output schema. Finish by calling the answer tool: its arguments are your " +
  "final answer and must satisfy that schema. Do not answer in prose."

const ANSWER_DESCRIPTION = "Deliver the final answer for this turn. The arguments are the answer."

// The answer tool is the turn's declared output schema as a tool, so a conforming call is parsed
// JSON by construction. The schema comes from the log, which is why the surface is a projection
// rather than a fixed list.
const answerTool = (
  log: ReadonlyArray<Event>,
  description: string
): ReadonlyArray<NativeToolSpec> => {
  const schema = outputSchemaOf(log)
  return schema === undefined
    ? []
    : [{ name: ANSWER, description, inputSchema: schema }]
}

interface Answer {
  readonly callId: string
  readonly arguments: unknown
  readonly turn: string
}

const answerOf = (context: Partial<Answer>): Answer => {
  if (context.callId === undefined) throw new Error("the contract is judging with no answer in context")
  return context as Answer
}

const isAnswer = (log: ReadonlyArray<Event>): boolean =>
  String(log[log.length - 1]?.name ?? "") === ANSWER

const contractMachine = machine({
  id: "contract",
  view: turnView,
  initial: "idle",
  // The context type is annotated on the value, not applied as a type argument, so the state names
  // stay inferred and a transition to an undeclared state fails to compile.
  context: {} as Partial<Answer>,
  states: {
    idle: {
      on: {
        ToolCalled: {
          target: "judging",
          when: isAnswer,
          assign: (_, event) => ({
            callId: String(event.callId ?? ""),
            arguments: event.arguments,
            turn: String(event.turn ?? "")
          })
        }
      }
    },
    // A conforming answer ends the turn and the call is acknowledged, so the rendered conversation
    // keeps its pairs. A failing one records the rejection as evidence and hands the reasons back
    // as the call's result, which is the repair.
    judging: {
      decide: (log, now, context) => {
        const answer = answerOf(context)
        const turn = answer.turn === "" ? turnOf(log) : answer.turn
        const errors = answerErrors(outputSchemaOf(log), answer.arguments)
        if (errors.length === 0) {
          return [
            {
              type: "ToolReturned",
              turn,
              callId: answer.callId,
              name: ANSWER,
              result: { accepted: true },
              at: now
            },
            { type: "TurnCompleted", turn, output: JSON.stringify(answer.arguments ?? null), at: now }
          ]
        }
        return [
          { type: "AnswerRejected", turn, callId: answer.callId, error: errors.join("; "), at: now },
          {
            type: "ToolReturned",
            turn,
            callId: answer.callId,
            name: ANSWER,
            result: null,
            error: repairText(errors),
            at: now
          }
        ]
      },
      on: { ToolReturned: "idle" }
    }
  }
})

export interface ContractOptions {
  readonly nudge?: string
  readonly answerDescription?: string
}

export const contract = (options: ContractOptions = {}) => {
  const text = options.nudge ?? ANSWER_TEXT
  const description = options.answerDescription ?? ANSWER_DESCRIPTION
  const answerNudge: Nudge = {
    id: "contract.answer",
    when: declaresOutput,
    text,
    nativeTools: (log) => answerTool(log, description)
  }
  return defineModule({
    id: "contract",
    version: "2",
    identity: { text, description },
    setup: () => ({
      events: ["AnswerRejected"],
      machines: [erase(contractMachine)],
      nudges: [answerNudge]
    })
  })
}
