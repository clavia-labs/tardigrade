# Event-driven bots

A bot reads events from a provider, serves each one as a turn, and posts the answer back. Slack, Linear, GitHub, and email all have this shape. This page states what tardigrade holds and what your process holds.

The complete runnable version lives at [examples/webhook-bot.ts](../../examples/webhook-bot.ts). Run it with `bun run examples/webhook-bot.ts`, then send it an event with the `curl` line it prints.

## The split

| Tardigrade holds | Your process holds |
| --- | --- |
| The log, the turn, and the transitions each event enables | The HTTP route, and the signature check over the request body |
| Delivery by message id, so a redelivered event lands once | The parse from the provider's payload into a `MessageReceived` |
| One drive pass at a time, so concurrent requests settle a lane once | The post back to the provider, as one keyed reactor |
| One timer per lane, at the instant that lane's log states | The vocabulary that timer fires, and the projection that finds it due |
| The owed work that survives a death, re-derived by `recover()` | The lane name each conversation gets |

Everything in the right column is provider knowledge. It changes when Slack changes, and it belongs in code you own.

## One lane per conversation

A lane is one log, one writer, and one serial conversation. The turn projections name a single current turn, so the messages of one lane are served in order and a queued message waits for the one ahead of it (`packages/code/src/turns.ts`).

Give each conversation its own lane. A Slack thread is a lane. A direct message channel is a lane. Two people in two threads then hold two turns at the same time, and neither waits for the other.

Lanes share what they have in common through a lane they all read. A reactor that holds `Facets` reads any lane by name, so a channel lane can carry facts that every thread lane in it reads (`packages/core/src/facets.ts`).

## Ingress

The route checks the signature, parses the payload, and delivers one event. The host owns everything after that.

```ts
import { createBunHost } from "@clavia/tardigrade/bun/host"

const host = await createBunHost({
  log: "bot.sqlite",
  actorFor: () => bot,
  layersFor: () => environment,
  keyOf: (event) => bot.keyOf(event)
})

// Work a deploy interrupted settles from the log that survived it.
await host.recover()

Bun.serve({
  port: 3000,
  fetch: async (request) => {
    const body = await request.text()
    if (!signed(request.headers, body)) return new Response("bad signature", { status: 401 })
    const inbound = inboundOf(JSON.parse(body))
    if (inbound === undefined) return new Response("ok")
    await host.deliver(host.self(inbound.thread), {
      type: "MessageReceived",
      id: inbound.eventId,
      text: inbound.text,
      chat: inbound.thread,
      sender: inbound.user,
      at: Date.now()
    })
    // The provider waits three seconds for this answer, so the turn runs after it.
    void host.drive().catch((error: unknown) => console.error(error))
    return new Response("ok")
  }
})
```

`id` is the dedup key. A provider that sends the same event twice lands it once, and a `MessageReceived` the lane already holds is dropped before it reaches the log.

`chat` and `sender` are the provider coordinates. Your egress reactor reads them to know where the answer goes and who asked.

## The drive

Drives are serialized and coalesced. A drive requested while one runs adds exactly one follow-up pass, and both callers await the same promise. So a lane settles once however many requests arrive together, and the effects inside a transition run once (`packages/host/src/host.test.ts`, "concurrent drives settle a lane once").

The promise resolves once the graph is quiet. A caller that delivered first is served by a pass that started after its event landed, so `await host.drive()` is enough to know the answer is on the log.

Concurrent handlers therefore need no lock of their own. Deliver, then drive, from every request.

## Egress

The post back to the provider is one reactor with one keyed transition. The key is the record: a post that committed is never derived again, and a crash before the record retries the post.

`turnHeads` names the turns, and your own marker event names the ones already answered. The absence of that marker is the owed post.

```ts
import { Clock, Effect } from "effect"
import type { Event } from "@clavia/tardigrade/core/event"
import type { KeyFragment } from "@clavia/tardigrade/core/event-log"
import { transition, type Reactor } from "@clavia/tardigrade/core/actor"
import { turnHeads, turnTerminalOf } from "@clavia/tardigrade/code/turns"

// The turn owed a post: a terminal on the log, and no Posted naming it.
const owed = (log: ReadonlyArray<Event>) =>
  turnHeads(log).find((head) => {
    const turn = String(head["id"])
    return (
      turnTerminalOf(log, turn) !== undefined &&
      !log.some((event) => event.type === "Posted" && event["turn"] === turn)
    )
  })

const postReactor: Reactor = (log) => {
  const head = owed(log)
  if (head === undefined) return []
  const turn = String(head["id"])
  const terminal = turnTerminalOf(log, turn) as { output?: unknown } | undefined
  return [
    transition({
      key: `post:${turn}`,
      input: { turn, chat: String(head["chat"]), text: String(terminal?.output ?? "") },
      act: (input) =>
        Effect.gen(function* () {
          // Where a real bot calls the provider's API.
          yield* Effect.promise(() => post(input.chat, input.text))
          const at = yield* Clock.currentTimeMillis
          return [{ type: "Posted", turn: input.turn, chat: input.chat, at }]
        })
    })
  ]
}

// The fragment that keys this reactor's own event. Two fragments claiming "post:" is an error at
// construction.
const postKeys: KeyFragment = {
  prefixes: ["post:"],
  keyOf: (event) => (event.type === "Posted" ? `post:${String(event["turn"])}` : undefined)
}
```

Mount it as a capability with no tools. `agentOf` composes the key fragments the same way it composes the reactors, so the host, the store, and the reactor share one derivation of what is already done.

```ts
import { agentOf, budget, codeMode, compaction } from "@clavia/tardigrade"

const bot = agentOf([
  codeMode,
  budget,
  compaction,
  { name: "chat", keys: postKeys, reactors: [postReactor] }
])
```

A post that fails records nothing, so the lane rests still owing it. The next delivery to that lane derives the post again. `recover()` derives it for every lane at once, which is what a process runs at start and what a loop of your own runs on an interval.

## Timers

The alarm holds one timer per lane. It answers two questions from that lane's log: the instant the lane is next owed a visit, and the fact to append when the instant arrives.

```ts
const host = await createBunHost({
  log: "bot.sqlite",
  actorFor: () => bot,
  layersFor: () => environment,
  keyOf: (event) => bot.keyOf(event),
  alarm: (_lane, events) => {
    const due = events.find(
      (event) =>
        event.type === "ReminderSet" &&
        !events.some((fired) => fired.type === "ReminderFired" && fired["id"] === event["id"])
    )
    if (due === undefined) return undefined
    return {
      at: Number(due["at"]),
      event: { type: "ReminderFired", id: due["id"], at: due["at"] } as Event
    }
  }
})
```

The vocabulary is yours. Tardigrade appends the fact and settles the lane, and your reactor reads the instant from the fact, because a reactor reads time as data on an event and never from the clock (`packages/core/src/actor.ts`).

The answer is a projection, so it survives a death. The host re-derives it after every settle and re-arms every lane in `recover()`, and a process that stops writing drops its timers in `close()`.

The fired fact must name its own occurrence in `keyOf`. The host refuses to arm a lane whose log already records that key, because a fact the log absorbs would arm the same instant forever.

## What a bot adds on top

A finished bot holds more than ingress and egress, and all of it is code you own over the log this host keeps.

- The provider's own rules: the signature window, the challenge handshake, the echo of the bot's own messages, and the mention prefix.
- The roster. `sender` is on every inbound, so who is present is a projection over the log.
- The formatting: message length, blocks, threads, reactions, and typing status.
- The policy on rapid messages. Three messages in five seconds are three turns, and folding them into one answer is a projection you write over `turnHeads`.
