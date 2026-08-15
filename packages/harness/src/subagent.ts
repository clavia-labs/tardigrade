import { Effect } from "effect"
import { Router, Self, type Event } from "@flamecast/core"
import { usageOf, type NativeTool, type NativeToolContext, type Usage } from "./infer"
import type { MessageOrigin } from "./module"
import { canonicalValue } from "./definition"
import { sha256 } from "./sha256"

// Delegation as one awaitable function with two faces. `callAgent` is the code face: a machine, a
// workflow, or a code-mode sandbox awaits it, and `Effect.all` over several calls is fan-out with
// the join written in ordinary code. `subagentTool` is the model face: the same call wrapped as a
// provider-native tool. Both faces send the same event and read the same reply, so moving
// orchestration authority between code and model changes configuration, never architecture.
//
// The boundary carries exactly two facts. Outward, `origin` names who asked. Homeward, the result
// carries the child's inclusive usage. Provenance trees and cost trees are derived from those two
// fields; nothing else crosses, and neither side reads the other's log.

export interface SubagentResult {
  readonly agent: string
  readonly turn: string
  readonly output?: string
  readonly error?: string
  readonly usage: Usage
}

export interface CallAgentMessage {
  readonly id: string
  readonly text: string
  readonly origin?: MessageOrigin
  readonly budget?: number
  readonly escalatable?: boolean
  // Where the answer goes when the work outlives this call. The target replies through the
  // asynchronous door and the caller reads the terminal of the dispatch rather than the answer.
  readonly replyTo?: string
}

// The terminal event of a routed call, read as a result. `TurnCompleted` carries the output;
// anything else reads as an error that names the event, so a parked or failed child is a value the
// caller can act on rather than a defect.
export const subagentResultOf = (address: string, terminal: Event, fallbackTurn: string): SubagentResult => {
  const turn = String(terminal.turn ?? fallbackTurn)
  const usage = usageOf(terminal.usage)
  if (terminal.type === "TurnCompleted") {
    return { agent: address, turn, output: String(terminal.output ?? ""), usage }
  }
  const reason =
    terminal.error !== undefined
      ? String(terminal.error)
      : `the agent ended with ${terminal.type}`
  return { agent: address, turn, error: reason, usage }
}

export const callAgent = (
  address: string,
  message: CallAgentMessage
): Effect.Effect<SubagentResult, never, Router> =>
  Effect.gen(function* () {
    const router = yield* Router
    const terminal = yield* router.call(address, {
      type: "MessageReceived",
      id: message.id,
      text: message.text,
      ...(message.origin === undefined ? {} : { origin: message.origin }),
      ...(message.budget === undefined ? {} : { budget: message.budget }),
      ...(message.escalatable === undefined ? {} : { escalatable: message.escalatable }),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo })
    })
    return subagentResultOf(address, terminal, message.id)
  })

export interface SubagentToolOptions {
  readonly name: string
  readonly description: string
  readonly address: string
  readonly inputSchema?: unknown
  readonly budget?: number
  readonly message?: (input: unknown) => string
  readonly callId?: (input: unknown, context?: NativeToolContext) => string
}

export const subagentTool = (options: SubagentToolOptions): NativeTool<Router | Self> => ({
  spec: {
    name: options.name,
    description: options.description,
    inputSchema:
      options.inputSchema ?? {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false
      }
  },
  run: (input, context) =>
    Effect.gen(function* () {
      const session = yield* Self
      const message =
        options.message?.(input) ??
        String((input as { readonly message?: unknown } | undefined)?.message ?? input)
      // The child turn id is derived from the parent turn and provider call, so a re-dispatched
      // tool call re-sends the same message and the child's dedup absorbs it.
      const id =
        options.callId?.(input, context) ??
        (context === undefined
          ? `${options.name}:${sha256(canonicalValue(input)).slice(0, 16)}`
          : `${options.name}:${context.turn}:${context.callId}`)
      return yield* callAgent(options.address, {
        id,
        text: message,
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        origin: {
          session,
          ...(context === undefined ? {} : { turn: context.turn, call: context.callId })
        }
      })
    })
})
