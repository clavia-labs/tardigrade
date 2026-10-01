import { RuntimeError, type Getter, type MethodResult } from "@clavia/tardigrade-experimental-core"
import { Schema } from "effect"
import { inferenceState } from "./atoms/durable/inference"

export const AgentMessageOutput = Schema.Struct({ text: Schema.String })
export type AgentMessageOutput = typeof AgentMessageOutput.Type

// agentReply projects a terminal turn into an invocation result for durable return delivery.
export function agentReply(id: string, get: Getter): MethodResult<AgentMessageOutput> | undefined {
  const turn = get(inferenceState).turns.find(turn => turn.turnId === id)
  if (!turn || turn.settlement === null) return undefined
  if (turn.settlement === "completed") {
    if (turn.answer === null) throw new RuntimeError("Completed turn has no answer")
    return { status: "completed", output: { text: turn.answer } }
  }
  if (turn.settlement === "failed") {
    if (turn.failure === null) throw new RuntimeError("Failed turn has no error")
    return { status: "failed", error: turn.failure }
  }
  if (turn.cancellation === null) throw new RuntimeError("Cancelled turn has no reason")
  return { status: "cancelled", reason: turn.cancellation }
}
