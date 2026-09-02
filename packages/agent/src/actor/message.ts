import { Schema } from "effect"
import { MessageReceived, messageReceived } from "@clavia/tardigrade-core/communication/message"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { boundaryOf } from "../output/boundary"
import { actorMethod, durableInputProjection } from "@clavia/tardigrade-core/actor/method"
import { intent } from "@clavia/tardigrade-core/reconciliation"
import { eventEpochOf, turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import {
  initialTurnProjection,
  reduceTurnProjection,
  turnEpochFrom,
  turnHeadFrom,
  turnTerminalAtFrom
} from "@clavia/tardigrade-code/execution/turn-projection"
import { ModelRef } from "../inference/reference"
import { ModelPolicy } from "../inference/access"
import { turnCancelled, turnFailed } from "../log/events"

export const AgentMessageInput = Schema.Struct({
  text: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(ModelRef)
}).annotate({ identifier: "AgentMessageInput" })

export type AgentMessageInput = typeof AgentMessageInput.Type

// AgentMessageReceived is the durable input contract interpreted by the message method.
export const AgentMessageReceived = Schema.Struct({
  ...MessageReceived.fields,
  model: Schema.optional(ModelRef),
  models: Schema.optional(ModelPolicy)
}).annotate({ identifier: "AgentMessageReceived" })

const turnOf = (event: Event): string => String((event as { readonly id?: unknown }).id)

const terminalKey = (event: Event, log: ReadonlyArray<Event>): string => {
  const turn = turnOf(event)
  const epoch = turnEpochOf(log, turn)
  return epoch === 0 ? `tn:${turn}` : `tn:${turn}/${epoch}`
}

interface MessageValidationState {
  readonly turns: ReturnType<typeof initialTurnProjection>
  readonly invalid: ReadonlyArray<{ readonly event: Event; readonly error: string }>
}

// agentMessageMethod exposes an agent turn as the generic message actor method.
export const agentMessageMethod = actorMethod({
  input: AgentMessageInput,
  output: Schema.String,
  currentEpoch: turnEpochOf,
  durableInput: {
    schema: AgentMessageReceived,
    matches: (event) => event.type === "MessageReceived",
    keyOf: ({ event, log }) => terminalKey(event, log),
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
    incremental: durableInputProjection({
      initial: (): MessageValidationState => ({ turns: initialTurnProjection(), invalid: [] }),
      step: (state, event): MessageValidationState => {
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
          invalid: error === undefined ? state.invalid : [...state.invalid, { event, error }]
        }
      },
      output: (state) => state.invalid.map(({ event, error }) => {
        const turn = turnOf(event)
        const epoch = turnEpochFrom(state.turns, turn)
        return intent({
          key: epoch === 0 ? `tn:${turn}` : `tn:${turn}/${epoch}`,
          input: { turn, epoch, error },
          events: (input, at) => [turnFailed({
            error: `invalid MessageReceived: ${input.error}; send a new corrected message`,
            cause: "message_invalid",
            attempts: 0,
            attemptKey: `${input.turn}/message`,
            turn: input.turn,
            ...(input.epoch === 0 ? {} : { epoch: input.epoch }),
            at
          })]
        })
      })
    })
  },
  event: ({ invocation, input, at }) => messageReceived({
    id: invocation.id,
    text: input.text,
    ...(invocation.epoch === 0 ? {} : { epoch: invocation.epoch }),
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.model === undefined ? {} : { model: input.model }),
    at
  }),
  incremental: {
    initial: initialTurnProjection,
    reduce: reduceTurnProjection,
    currentEpoch: turnEpochFrom,
    cancellation: (state, invocation) => {
      if (turnHeadFrom(state, invocation.id) === undefined) return undefined
      const terminal = turnTerminalAtFrom(state, invocation.id, invocation.epoch)
      if (terminal !== undefined) return terminal.type === "TurnCancelled" ? "cancelled" : "terminal"
      return turnEpochFrom(state, invocation.id) === invocation.epoch ? "running" : undefined
    },
    state: (state, invocation) => {
      const head = turnHeadFrom(state, invocation.id) as { readonly output?: unknown } | undefined
      if (head === undefined) return undefined
      const data = head.output === undefined ? undefined : { output: head.output }
      const terminal = turnTerminalAtFrom(state, invocation.id, invocation.epoch) as Record<string, unknown> | undefined
      if (terminal === undefined) return { status: "pending" as const }
      if (terminal.type === "TurnCompleted") {
        return { status: "completed" as const, output: String(terminal.output ?? ""), ...(data === undefined ? {} : { data }) }
      }
      if (terminal.type === "TurnFailed") {
        return { status: "failed" as const, error: String(terminal.error ?? "turn failed"), ...(data === undefined ? {} : { data }) }
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
  },
  cancellation: {
    state: (events, invocation) => {
      const { id, epoch } = invocation
      const invoked = events.some((event) =>
        event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === id
      )
      if (!invoked) return undefined
      const terminal = events.find((event) =>
        (event.type === "TurnCompleted" || event.type === "TurnFailed" || event.type === "TurnCancelled") &&
        String((event as { readonly turn?: unknown }).turn) === id &&
        eventEpochOf(event) === epoch
      )
      if (terminal !== undefined) return terminal.type === "TurnCancelled" ? "cancelled" : "terminal"
      return turnEpochOf(events, id) === epoch ? "running" : undefined
    },
    event: (cancellation, at) => turnCancelled({
      request: cancellation.request,
      cause: cancellation.cause,
      ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
      ...(cancellation.deadlineAt === undefined ? {} : { deadlineAt: cancellation.deadlineAt }),
      turn: cancellation.invocation.id,
      ...(cancellation.invocation.epoch === 0 ? {} : { epoch: cancellation.invocation.epoch }),
      at
    })
  },
  state: (events, invocation) => {
    const { id } = invocation
    const invoked = events.find((event) =>
      event.type === "MessageReceived" && (event as { readonly id?: unknown }).id === id
    ) as { readonly output?: unknown } | undefined
    if (invoked === undefined) return undefined
    const data = invoked.output === undefined ? undefined : { output: invoked.output }
    const boundary = boundaryOf(events, id)
    if (boundary === undefined) return { status: "pending" }
    if (boundary.kind === "completed") {
      return { status: "completed", output: boundary.output, ...(data === undefined ? {} : { data }) }
    }
    if (boundary.kind === "failed") {
      return { status: "failed", error: boundary.error, ...(data === undefined ? {} : { data }) }
    }
    if (boundary.kind === "cancelled") {
      return {
        status: "cancelled",
        cause: boundary.cause,
        ...(boundary.reason === undefined ? {} : { reason: boundary.reason }),
        ...(boundary.deadlineAt === undefined ? {} : { deadlineAt: boundary.deadlineAt }),
        ...(data === undefined ? {} : { data })
      }
    }
    return { status: "pending" }
  }
})
