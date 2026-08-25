import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Event } from "../../log/event"
import { Self } from "../../reconciliation"
import { Router } from "../../communication/router"
import { actorIdOf } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { actorMethod, actorMethodsOf } from "./definition"
import { methodResponseReactor } from "./response"
import { EventLog, withWatermark } from "../../log"

const source = actorIdOf("parent", "root")
const target = actorIdOf("child", "worker")

const call = {
  type: "Asked",
  id: "call-1",
  input: "work",
  call: { method: "ask", id: "call-1" },
  link: linkOf(source, target),
  at: 1
} as Event

const methods = actorMethodsOf({
  ask: actorMethod({
    input: Schema.String,
    output: Schema.String,
    event: ({ id, input, at }): Event => ({ type: "Asked", id, input, at }),
    state: (events, id) => {
      if (!events.some((event) => event.type === "Asked" && (event as { readonly id?: unknown }).id === id)) {
        return undefined
      }
      const completed = events.find((event) =>
        event.type === "Answered" && (event as { readonly call?: unknown }).call === id
      ) as { readonly output?: unknown } | undefined
      if (completed !== undefined) return { status: "completed", output: String(completed.output) }
      return { status: "pending" }
    }
  })
})

describe("methodResponseReactor", () => {
  test("returns a terminal through the accepted call link", async () => {
    const sent: unknown[] = []
    const transition = methodResponseReactor(methods)([
      call,
      { type: "Answered", call: "call-1", output: "done", at: 2 } as Event
    ])[0]!
    expect(transition.kind).toBe("effect")
    if (transition.kind !== "effect") return

    const returned = await Effect.runPromise(transition.act(transition.input).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, target),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))

    expect(sent).toEqual([
      expect.objectContaining({
        link: { source: target, target: source },
        event: expect.objectContaining({
          type: "MethodResponseReceived",
          id: "call-1.reply",
          method: "ask",
          call: "call-1",
          status: "completed",
          output: "done"
        })
      })
    ])
    expect(returned).toEqual([
      expect.objectContaining({
        type: "MethodResponseDelivered",
        method: "ask",
        call: "call-1",
        revision: "completed"
      })
    ])
  })

  test("a delivery record suppresses the same response", () => {
    const log: ReadonlyArray<Event> = [
      call,
      { type: "Answered", call: "call-1", output: "done", at: 2 } as Event,
      { type: "MethodResponseDelivered", method: "ask", call: "call-1", revision: "completed", at: 3 } as Event
    ]
    expect(methodResponseReactor(methods)(log)).toEqual([])
  })
})
