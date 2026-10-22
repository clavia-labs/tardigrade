import { Context, Effect, Random, Queue } from "effect"
import { RuntimeError, atom } from "@clavia/tardigrade-core"
import { EventLog, eventLogContext } from "@clavia/tardigrade-core/services/event-log"
import { agentEvent, chatMessage, type ChatMessage } from "@clavia/tardigrade-agent/atoms/messages"
import { turnOutput } from "@clavia/tardigrade-agent/atoms/durable/inference"
import type { TurnSettled, Event } from "@clavia/tardigrade-agent/contracts/events"
import type { PromptMessage } from "./prompt"
import type { ChatThread } from "./threads"

// journal reads the thread's committed records without folding them into state.
const journal = atom(get => {
  const context = get(eventLogContext)
  if (!context) throw new RuntimeError("Missing EventLog service")
  const records = Context.get(context, EventLog).records
  if (!records) throw new RuntimeError("Thread store does not expose journal records")
  return get(records)
})

const eventsOf = (records: Iterable<Parameters<typeof agentEvent>[0]>) => [...records].flatMap(record => agentEvent(record) ?? [])
// outputOf resolves completed turn text from records after from, reading the whole journal only when the turn's model call precedes them.
const outputOf = (log: { readonly slice: (start?: number) => readonly Parameters<typeof agentEvent>[0][] }, from: number) => (settlement: TurnSettled) => {
  try { return turnOutput(eventsOf(log.slice(from)), settlement) }
  catch (error) { if (from === 0) throw error; return turnOutput(eventsOf(log.slice(0)), settlement) }
}

export const sendMessage = (thread: ChatThread, text: string) => Effect.gen(function* () {
  const turnId = `${yield* Random.nextInt}:${yield* Random.nextInt}`
  const view = thread.store.select(journal)
  const start = view.get().length
  yield* thread.invoke("message", { text }, { id: turnId })
  yield* thread.wait
  const log = view.get()
  const settlements = eventsOf(log.slice(start)).filter((event): event is Extract<Event, { readonly type: "TurnSettled" }> => event.type === "TurnSettled")
  if (!settlements.some(settlement => settlement.turnId === turnId)) return yield* Effect.fail(new RuntimeError("The turn ended without a result"))
  const output = outputOf(log, start)
  return settlements.map(settlement => ({
    turnId: settlement.turnId,
    outcome: settlement.outcome,
    text: settlement.outcome === "completed" ? output(settlement) : settlement.reason,
  }))
}).pipe(Effect.mapError(RuntimeError.from))

// observeMessages queues each new chat message once until the selected thread scope closes.
export const observeMessages = (thread: ChatThread) => Effect.gen(function* () {
  const queue = yield* Queue.unbounded<PromptMessage>()
  const view = thread.store.select(journal)
  let after = view.get().length
  const publish = (log: ReturnType<typeof view.get>) => {
    const from = after
    const output = outputOf(log, from)
    for (let seq = from; seq < log.length; seq++) {
      const event = agentEvent(log.at(seq)!)
      const entry: ChatMessage | undefined = event && chatMessage(seq, event, output)
      if (entry) Queue.offerUnsafe(queue, entry)
    }
    after = Math.max(after, log.length)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => view.subscribe(publish)),
    unsubscribe => Effect.sync(unsubscribe),
  )
  yield* Effect.addFinalizer(() => Queue.shutdown(queue))
  return queue
})
