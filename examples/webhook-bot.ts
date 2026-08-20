// A bot over a provider's webhooks, assembled from the library's parts and run on the durable Bun
// host: bun run examples/webhook-bot.ts. One route takes the provider's events, one reactor posts
// each answer back, and the platform alarm holds the reminders. The model is scripted, so the run
// needs no API key; swap it for infer(...) to make it an agent (examples/rlm-agent.ts).
//
// The page that explains the split between what tardigrade holds and what this file holds is
// docs/how-to/events.md.
//
// The workspace names resolve in this repository. Against the published package they are
// "@clavia/tardigrade", "@clavia/tardigrade/core/actor", "@clavia/tardigrade/code/turns", and
// "@clavia/tardigrade/bun/host" (tools/publish.ts).
import { Clock, Effect, Layer } from "effect"
import { agentOf, budget, codeMode, compaction, Infer, type Capability } from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import type { KeyFragment } from "@clavia/tardigrade-core/event-log"
import { turnHeads, turnTerminalOf } from "@clavia/tardigrade-code/turns"
import { createBunHost } from "@clavia/tardigrade-bun/host"

// This bot's own vocabulary. The framework reads none of these; what it reads is the key that
// records each one, so a transition that fired is never derived again and a redelivery of the same
// fact is absorbed (packages/core/src/event-log.ts, KeyFragment).
const botKeys: KeyFragment = {
  prefixes: ["post:", "rem:", "fire:"],
  keyOf: (event) => {
    if (event.type === "Posted") return `post:${String(event["turn"])}`
    if (event.type === "ReminderSet") return `rem:${String(event["id"])}`
    if (event.type === "ReminderFired") return `fire:${String(event["id"])}`
    return undefined
  }
}

// The egress. A real bot sends the answer to the provider's API here; this one prints it, so the
// example runs with no credentials.
const post = async (chat: string, text: string): Promise<void> => {
  console.log(`-> ${chat}: ${text}`)
}

// The turn owed a post: a terminal on the log, and no Posted naming it. turnHeads is the
// framework's own list of the messages that head turns, so a reply an open package call was
// awaiting never becomes a post of its own (packages/code/src/turns.ts).
const owedPost = (log: ReadonlyArray<Event>): Event | undefined =>
  turnHeads(log).find((head) => {
    const turn = String(head["id"])
    return (
      turnTerminalOf(log, turn) !== undefined &&
      !log.some((event) => event.type === "Posted" && event["turn"] === turn)
    )
  })

// One post per answered turn. The key is the record: a committed post is never derived again, and a
// crash between the send and the record retries the send, which is at-least-once like every effect
// here.
const postReactor: Reactor = (log) => {
  const head = owedPost(log)
  if (head === undefined) return []
  const turn = String(head["id"])
  const terminal = turnTerminalOf(log, turn) as { output?: unknown; error?: unknown } | undefined
  return [
    transition({
      key: `post:${turn}`,
      input: {
        turn,
        chat: String(head["chat"] ?? ""),
        text: terminal?.error === undefined ? String(terminal?.output ?? "") : `error: ${String(terminal.error)}`
      },
      act: (input) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => post(input.chat, input.text))
          const at = yield* Clock.currentTimeMillis
          return [{ type: "Posted", turn: input.turn, chat: input.chat, at }]
        })
    })
  ]
}

// A fired reminder heads a turn of its own. The transition's key is the message id it is about to
// write, so one reminder can never open two turns and the reactor needs no memory of its own
// (packages/core/src/actor.ts, Reactor).
const remindReactor: Reactor = (log) =>
  log
    .filter((event) => event.type === "ReminderFired")
    .map((event) => {
      const id = `rem-${String(event["id"])}`
      return transition({
        key: `msg:${id}`,
        input: { id, text: String(event["text"] ?? ""), chat: String(event["chat"] ?? "") },
        act: (input) =>
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis
            return [{ type: "MessageReceived", id: input.id, text: input.text, chat: input.chat, at }]
          })
      })
    })

// The bot: the library's work surface and policies, plus this file's two reactors as one capability
// with no tools. agentOf composes the key fragments the way it composes the reactors, so the host,
// the store, and the reactors share one derivation of what is already done.
const bot = agentOf([
  codeMode,
  budget,
  compaction,
  { name: "chat", keys: botKeys, reactors: [postReactor, remindReactor] } satisfies Capability
])

// The scripted mind: it answers the brief in one attempt. Swap this layer for infer(...) against an
// OpenAI-compatible endpoint to make the bot think.
const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String(event["text"] ?? "")
  }
  return ""
}

const scripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: (request) => Effect.succeed<Action>({ kind: "complete", output: `noted: ${briefOf(request.trajectory)}` })
})

// The due reminder: one with no ReminderFired naming it. This is a projection of the lane's log, so
// it survives a death and recover() re-arms it.
const dueReminder = (events: ReadonlyArray<Event>): Event | undefined =>
  events.find(
    (event) =>
      event.type === "ReminderSet" &&
      !events.some((fired) => fired.type === "ReminderFired" && fired["id"] === event["id"])
  )

// One lane per conversation, so two threads hold two turns at the same time and neither waits for
// the other. The alarm answers two questions from that lane's log: when the lane is next owed a
// visit, and the fact to append when the instant arrives.
const host = await createBunHost({
  log: new URL("./.data/bot.sqlite", import.meta.url).pathname,
  actorFor: (lane) => (lane.startsWith("ch.") ? bot : undefined),
  layersFor: () => scripted,
  keyOf: (event) => bot.keyOf(event),
  alarm: (_lane, events) => {
    const due = dueReminder(events)
    if (due === undefined) return undefined
    return {
      at: Number(due["at"]),
      event: { type: "ReminderFired", id: due["id"], text: due["text"], chat: due["chat"], at: due["at"] }
    }
  }
})

// Work a death interrupted settles from the log that survived it, and every lane that owes a future
// visit is armed again.
await host.recover()

// The provider's payload, as this door reads it. A real adapter checks the signature over the raw
// body, answers the provider's challenge, and drops the messages the bot itself sent.
interface Hook {
  readonly id: string
  readonly thread: string
  readonly user: string
  readonly text: string
  readonly remindAt?: number
}

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 3000),
  fetch: async (request) => {
    const hook = (await request.json()) as Hook
    const lane = `ch.${hook.thread}`
    const at = Date.now()
    // A reminder is a fact of this lane, and the alarm reads it as the instant the lane is next
    // owed a visit. Anything else is a turn.
    const event: Event =
      hook.remindAt === undefined
        ? { type: "MessageReceived", id: hook.id, text: hook.text, chat: hook.thread, sender: hook.user, at }
        : { type: "ReminderSet", id: hook.id, text: hook.text, chat: hook.thread, at: hook.remindAt }
    await host.deliver(host.self(lane), event)
    // The provider waits seconds for this answer, so the turn runs after it. Drives are serialized
    // and coalesced, so concurrent requests settle one lane once (packages/host/src/host.ts).
    void host.drive().catch((error: unknown) => console.error(error))
    return new Response("ok")
  }
})

console.log(`listening on ${server.url.href}`)
console.log(
  `curl -X POST ${server.url.href} -d '{"id":"m1","thread":"design","user":"u1","text":"what shipped today?"}'`
)
