import { Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { ModelReply, type Event, type TurnSettled } from "./event"

// turnOutput resolves a completed turn's model result and accepts historical inline answers.
export function turnOutput(events: readonly Event[], settlement: TurnSettled): string {
  if (settlement.outcome !== "completed") throw new RuntimeError(settlement.reason)
  if ("output" in settlement) return settlement.output
  const called = events.find(event => event.type === "ModelCalled" && event.purpose === "inference" && event.callId === settlement.callId && event.turnId === settlement.turnId)
  if (!called) throw new RuntimeError(`No matching model call for turn: ${settlement.turnId}`)
  const returned = events.find(event => event.type === "ModelReturned" && event.purpose === "inference" && event.callId === settlement.callId)
  if (!returned || returned.type !== "ModelReturned" || returned.purpose !== "inference") throw new RuntimeError(`Missing model result: ${settlement.callId}`)
  let reply: typeof ModelReply.Type
  if ("promise" in returned) {
    const ref = returned.promise.ref
    const settled = events.find(event => event.type === "PromiseSettled" && event.ref.seq === ref.seq && event.ref.atom === ref.atom && event.ref.tag === ref.tag)
    if (!settled || settled.type !== "PromiseSettled" || settled.result.status !== "fulfilled") throw new RuntimeError(`Model result is not fulfilled: ${settlement.callId}`)
    reply = Schema.decodeUnknownSync(ModelReply)(settled.result.value)
  } else {
    reply = returned
  }
  if (reply.toolCalls.length) throw new RuntimeError(`Model result still requests tools: ${settlement.callId}`)
  return reply.text
}
