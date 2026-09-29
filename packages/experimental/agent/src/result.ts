import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { type Event, type TurnSettled } from "./event"

// turnOutput reads the answer of a completed turn.
export function turnOutput(events: readonly Event[], settlement: TurnSettled): string {
  if (settlement.outcome !== "completed") throw new RuntimeError(settlement.reason)
  if ("output" in settlement) return settlement.output
  const called = events.find(event => event.type === "ModelCalled" && event.purpose === "inference" && event.callId === settlement.callId && event.turnId === settlement.turnId)
  if (!called) throw new RuntimeError(`No matching model call for turn: ${settlement.turnId}`)
  const returned = events.find(event => event.type === "ModelReturned" && event.purpose === "inference" && event.callId === settlement.callId)
  if (!returned || returned.type !== "ModelReturned" || returned.purpose !== "inference") throw new RuntimeError(`Missing model result: ${settlement.callId}`)
  const reply = returned
  if (reply.toolCalls.length) throw new RuntimeError(`Model result still requests tools: ${settlement.callId}`)
  return reply.text
}
