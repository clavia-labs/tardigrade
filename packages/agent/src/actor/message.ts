import { upcastError } from "../log/upcast"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { actorMethod, durableInputProjection } from "@clavia/tardigrade-core/actor/method"
import { type TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnEpochFrom,
  turnHeadFrom,
  turnTerminalAtFrom
} from "@clavia/tardigrade-code/execution/turn-projection"
import { ModelRef } from "../model/reference"
import { AgentMessageReceived, MessageContent } from "../log/message"
export { AgentMessageReceived } from "../log/message"
import { turnCancelled, turnFailed } from "../log/events"

const inputFields = {
  input: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(ModelRef)
}

// AgentMessageInput accepts stored attachments or legacy text (message.test.ts).
export const AgentMessageInput = Schema.Union([
  Schema.Struct({
    ...inputFields,
    content: MessageContent,
    text: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    ...inputFields,
    /** @deprecated Use content with a text part. */
    text: Schema.String,
    content: Schema.optionalKey(Schema.Never)
  })
]).annotate({ identifier: "AgentMessageInput" })

export type AgentMessageInput = typeof AgentMessageInput.Type

const turnOf = (event: Event): string => String((event as { readonly id?: unknown }).id)


interface MessageValidationState {
  readonly turns: ReturnType<typeof initialTurnProjection>
  readonly invalid: ReadonlyArray<{ readonly event: Event; readonly error: string; readonly context: TransitionContext }>
}

// agentMessageMethod exposes an agent turn as the generic message actor method.
export const agentMessageMethod = actorMethod({
  input: AgentMessageInput,
  output: Schema.String,
  durableInput: {
    schema: AgentMessageReceived,
    matches: (event) => event.type === "MessageReceived",
    reject: ({ event, log, error }, at) => {
      const turn = turnOf(event)
      const epoch = turnEpochOf(log, turn)
      return turnFailed({
        error: `invalid MessageReceived: ${error}; send a new corrected message`,
        cause: "message_invalid",
        attempts: 0,
        attemptKey: `${turn}/message`,
        turn,
        ...(epoch === 0 ? {} : { epoch }),
        at
      })
    },
    projection: durableInputProjection({
      initial: (): MessageValidationState => ({ turns: initialTurnProjection(), invalid: [] }),
      step: (state, event, context): MessageValidationState => {
        let error: string | undefined
        if (event.type === "MessageReceived") {
          try {
            Schema.decodeUnknownSync(AgentMessageReceived)(event)
          } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure)
          }
        }
        return {
          turns: reduceTurnProjection(state.turns, event),
          invalid: error === undefined ? state.invalid : [...state.invalid, { event, error, context }]
        }
      },
      output: (state) => state.invalid.map(({ event, error, context }) => {
        const turn = turnOf(event)
        const epoch = turnEpochFrom(state.turns, turn)
        return context.intent("reject", (at) => turnFailed({
          error: `invalid MessageReceived: ${error}; send a new corrected message`,
          cause: "message_invalid", attempts: 0, attemptKey: `${turn}/message`, turn,
          ...(epoch === 0 ? {} : { epoch }), at
        }), { invocation: null })
      })
    })
  },
  event: ({ invocation, input, at }) => ({
    type: "MessageReceived",
    id: invocation.id,
    ...(input.content === undefined ? { text: input.text } : { content: input.content }),
    ...(invocation.epoch === 0 ? {} : { epoch: invocation.epoch }),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.model === undefined ? {} : { model: input.model }),
    at
  }),
  projection: {
    initial: initialTurnProjection,
    step: reduceTurnProjection,
    output: (state) => ({
      currentEpoch: (id) => turnEpochFrom(state, id),
      invocationState: (invocation) => {
        const head = turnHeadFrom(state, invocation.id) as { readonly output?: unknown } | undefined
        if (head === undefined) return undefined
        const data = head.output === undefined ? undefined : { output: head.output }
        const terminal = turnTerminalAtFrom(state, invocation.id, invocation.epoch) as Record<string, unknown> | undefined
        if (terminal === undefined) return { status: "pending" as const }
        if (terminal.type === "TurnCompleted") {
          return { status: "completed" as const, output: String(terminal.output ?? ""), ...(data === undefined ? {} : { data }) }
        }
        if (terminal.type === "TurnFailed") {
          return { status: "failed" as const, error: upcastError(terminal.error ?? "turn failed").message, ...(data === undefined ? {} : { data }) }
        }
        if (terminal.type === "TurnCancelled") {
          return {
            status: "cancelled" as const,
            cause: terminal.cause === "deadline" ? "deadline" as const : "requested" as const,
            ...(typeof terminal.reason === "string" ? { reason: terminal.reason } : {}),
            ...(typeof terminal.deadlineAt === "number" ? { deadlineAt: terminal.deadlineAt } : {}),
            ...(data === undefined ? {} : { data })
          }
        }
        return { status: "pending" as const }
      }
    })
  },
  cancellation: {
    event: (cancellation, at) => turnCancelled({
      request: cancellation.request,
      cause: cancellation.cause,
      ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
      ...(cancellation.deadlineAt === undefined ? {} : { deadlineAt: cancellation.deadlineAt }),
      turn: cancellation.invocation.id,
      ...(cancellation.invocation.epoch === 0 ? {} : { epoch: cancellation.invocation.epoch }),
      at
    })
  }
})
