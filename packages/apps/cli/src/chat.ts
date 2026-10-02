import { Effect, Random, Queue } from "effect"
import { RuntimeError } from "@clavia/tardigrade-core"
import { messages, type ChatMessage } from "@clavia/tardigrade-agent/atoms/messages"
import { history } from "@clavia/tardigrade-agent/atoms/activity"
import { turnOutput } from "@clavia/tardigrade-agent/atoms/durable/inference"
import type { PromptMessage } from "./prompt"
import type { ChatThread } from "./threads"

export const sendMessage = (thread: ChatThread, text: string) => Effect.gen(function* () {
  const turnId = `${yield* Random.nextInt}:${yield* Random.nextInt}`
  const start = thread.store.select(history).get().length
  yield* thread.invoke("message", { text }, { id: turnId })
  yield* thread.wait
  const events = thread.store.select(history).get()
  const result = events.findLast(event => event.type === "TurnSettled" && event.turnId === turnId)
  if (!result || result.type !== "TurnSettled") return yield* Effect.fail(new RuntimeError("The turn ended without a result"))
  return events.slice(start).filter(event => event.type === "TurnSettled").map(settlement => ({
    turnId: settlement.turnId,
    outcome: settlement.outcome,
    text: settlement.outcome === "completed" ? turnOutput(events, settlement) : settlement.reason,
  }))
}).pipe(Effect.mapError(RuntimeError.from))

// observeMessages queues each new chat message once until the selected thread scope closes.
export const observeMessages = (thread: ChatThread) => Effect.gen(function* () {
  const queue = yield* Queue.unbounded<PromptMessage>()
  const view = thread.store.select(messages)
  let after = thread.store.select(history).get().length - 1
  const publish = (entries: readonly ChatMessage[]) => {
    for (const entry of entries) if (entry.seq > after) {
      Queue.offerUnsafe(queue, entry)
      after = entry.seq
    }
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => view.subscribe(publish)),
    unsubscribe => Effect.sync(unsubscribe),
  )
  yield* Effect.addFinalizer(() => Queue.shutdown(queue))
  return queue
})
