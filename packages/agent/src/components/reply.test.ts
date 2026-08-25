import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/event-log"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Envelope } from "@clavia/tardigrade-core/communication/envelope"
import { replyReactor } from "./reply"

const fireReply = async (log: ReadonlyArray<Event>, self: { readonly actor: string; readonly thread: string }) => {
  const sent: Array<Envelope<unknown, Event, unknown>> = []
  const transition = replyReactor(log)[0]!
  if (transition.kind !== "effect") throw new Error("reply must be an effect")
  const layers = Layer.mergeAll(
    Layer.succeed(Router, {
      send: (envelope) => Effect.sync(() => sent.push(envelope))
    }),
    Layer.succeed(Self, self),
    Layer.succeed(EventLog, withWatermark({
      append: () => Effect.void,
      read: Effect.succeed(log)
    }))
  )
  const returned = await Effect.runPromise(
    transition.act(transition.input).pipe(Effect.provide(layers))
  )
  return { returned, sent }
}

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
    const { returned, sent } = await fireReply(log, { actor: "support", thread: "incident" })

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

  test("reverses the actor link persisted with the inbound message", async () => {
    const { returned, sent } = await fireReply([
      {
        type: "MessageReceived",
        id: "run-worker",
        text: "inspect",
        link: {
          source: { actor: "factory", thread: "main" },
          target: { actor: "factory", thread: "worker" }
        },
        at: 1
      },
      { type: "TurnCompleted", turn: "run-worker", output: "done", at: 2 }
    ], { actor: "factory", thread: "worker" })

    expect(sent[0]?.link).toEqual({
      source: { actor: "factory", thread: "worker" },
      target: { actor: "factory", thread: "main" }
    })
    expect(returned[0]).toMatchObject({
      type: "ReplyDelivered",
      to: "factory:main",
      turn: "run-worker"
    })
  })

  test("reports a budget request through the same reversed actor link", async () => {
    const log: ReadonlyArray<Event> = [
      {
        type: "MessageReceived",
        id: "run-worker",
        text: "inspect",
        link: {
          source: { actor: "factory", thread: "main" },
          target: { actor: "factory", thread: "worker" }
        },
        at: 1
      },
      { type: "BudgetExhausted", budget: 2, used: 3, turn: "run-worker", at: 2 },
      { type: "BudgetRequested", callId: "request-1", reason: "one source remains", amount: 2, turn: "run-worker", at: 3 }
    ]

    const { returned, sent } = await fireReply(log, { actor: "factory", thread: "worker" })

    expect(sent).toEqual([
      expect.objectContaining({
        link: {
          source: { actor: "factory", thread: "worker" },
          target: { actor: "factory", thread: "main" }
        },
        event: expect.objectContaining({
          type: "MessageReceived",
          id: "run-worker.reply",
          outcome: "requesting",
          text: "one source remains",
          data: { request: "request-1", reason: "one source remains", amount: 2, round: 0 }
        })
      })
    ])
    expect(returned).toEqual([
      expect.objectContaining({
        type: "BudgetRequestReported",
        request: "request-1",
        turn: "run-worker",
        round: 0
      })
    ])
    expect(replyReactor([...log, ...returned])).toEqual([])
  })

  test("settles an unlinked inbound without sending a reply", async () => {
    const { returned, sent } = await fireReply([
      { type: "MessageReceived", id: "m2", text: "inspect", at: 1 },
      { type: "TurnCompleted", turn: "m2", output: "done", at: 2 }
    ], { actor: "support", thread: "incident" })

    expect(sent).toEqual([])
    expect(returned).toEqual([
      expect.objectContaining({ type: "ReplyDelivered", turn: "m2" })
    ])
    expect(returned[0]).not.toHaveProperty("to")
  })

  describe("terminal reports cannot start reply chains", () => {
    for (const outcome of ["completed", "failed"] as const) {
      test(outcome, async () => {
        const terminal: Event = outcome === "completed"
          ? { type: "TurnCompleted", turn: "run-worker", output: "world built", at: 2 }
          : { type: "TurnFailed", turn: "run-worker", error: "worker failed", at: 2 }
        const first = await fireReply([
          {
            type: "MessageReceived",
            id: "run-worker",
            text: "build the world",
            link: {
              source: { actor: "factory", thread: "main" },
              target: { actor: "factory", thread: "worker" }
            },
            at: 1
          },
          terminal
        ], { actor: "factory", thread: "worker" })
        const report = first.sent[0]
        if (report === undefined) throw new Error("the worker did not send its terminal report")

        expect(report.event).toMatchObject({
          type: "MessageReceived",
          id: "run-worker.reply",
          outcome
        })

        const second = await fireReply([
          { ...report.event, link: report.link } as Event,
          { type: "TurnCompleted", turn: "run-worker.reply", output: "acknowledged", at: 3 }
        ], { actor: "factory", thread: "main" })

        expect(second.sent).toEqual([])
        expect(second.returned).toEqual([
          expect.objectContaining({ type: "ReplyDelivered", turn: "run-worker.reply" })
        ])
        expect(second.returned[0]).not.toHaveProperty("to")
      })
    }
  })
})
