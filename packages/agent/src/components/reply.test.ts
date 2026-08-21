import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { replyReactor } from "./reply"

describe("replyReactor", () => {
  test("reverses the provider link persisted with the inbound message", async () => {
    const inbound: Event = {
      type: "MessageReceived",
      id: "m1",
      text: "investigate",
      link: {
        source: { provider: "telegram-support", chat: "-100123", topic: 42 },
        target: { actor: "support", thread: "incident" }
      },
      at: 1
    }
    const log: ReadonlyArray<Event> = [
      inbound,
      { type: "TurnCompleted", turn: "m1", output: "fixed", at: 2 }
    ]
    const sent: Array<{ readonly link: unknown; readonly event: Event }> = []
    const transition = replyReactor(log)[0]!
    const layers = Layer.mergeAll(
      Layer.succeed(Router, {
        deliver: (link, event) => Effect.sync(() => sent.push({ link, event })),
        call: () => Effect.succeed({ error: "unused" }),
        resume: () => Effect.succeed({ error: "unused" })
      }),
      Layer.succeed(Self, { actor: "support", thread: "incident" }),
      Layer.succeed(EventLog, withWatermark({
        append: () => Effect.void,
        read: Effect.succeed(log)
      }))
    )

    const returned = await Effect.runPromise(
      transition.act(transition.input).pipe(Effect.provide(layers))
    )

    expect(sent[0]?.link).toEqual({
      source: { actor: "support", thread: "incident" },
      target: { provider: "telegram-support", chat: "-100123", topic: 42 }
    })
    expect(sent[0]?.event).toMatchObject({
      type: "MessageReceived",
      id: "m1.reply",
      text: "fixed",
      outcome: "completed",
      from: "support:incident"
    })
    expect(returned[0]).toMatchObject({
      type: "ReplyDelivered",
      to: "telegram-support",
      turn: "m1"
    })
  })
})
