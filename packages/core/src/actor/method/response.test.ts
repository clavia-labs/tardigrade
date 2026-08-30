import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Event } from "../../log/event"
import { Self } from "../../reconciliation"
import { Router } from "../../communication/router"
import { threadAddressOf } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { actorMethod, actorMethodsOf } from "./definition"
import { methodResponseReactor } from "./response"
import { EventLog, withWatermark } from "../../log"

const source = threadAddressOf("parent", "main", "root")
const target = threadAddressOf("child", "main", "worker")

const call = {
  type: "Asked",
  id: "call-1",
  input: "work",
  call: { invocation: { method: "ask", id: "call-1", epoch: 0 } },
  link: linkOf(source, target),
  at: 1
} as Event

const methods = actorMethodsOf({
  ask: actorMethod({
    input: Schema.String,
    output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "Asked", id: invocation.id, input, at }),
    state: (events, invocation) => {
      const { id } = invocation
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

    const returned = await Effect.runPromise(transition.act(transition.input, new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(Self, target),
      Layer.succeed(Router, { send: (envelope) => Effect.sync(() => void sent.push(envelope)) }),
      Layer.succeed(EventLog, withWatermark({ append: () => Effect.void, read: Effect.succeed([]) }))
    ))))

    expect(sent).toEqual([
      expect.objectContaining({
        link: { source: target, target: source },
        event: expect.objectContaining({
          type: "ResponseReceived",
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
        type: "ResponseDelivered",
        method: "ask",
        call: "call-1"
      })
    ])
  })

  test("a delivery record suppresses the same response", () => {
    const log: ReadonlyArray<Event> = [
      call,
      { type: "Answered", call: "call-1", output: "done", at: 2 } as Event,
      { type: "ResponseDelivered", method: "ask", call: "call-1", at: 3 } as Event
    ]
    expect(methodResponseReactor(methods)(log)).toEqual([])
  })

  test("invalid output becomes a failed response before crossing the link", () => {
    const invalid = actorMethodsOf({
      ask: actorMethod({
        input: Schema.String,
        output: Schema.String,
        event: ({ invocation, input, at }): Event => ({ type: "Asked", id: invocation.id, input, at }),
        state: () => ({ status: "completed", output: 42 as never })
      })
    })
    const transition = methodResponseReactor(invalid)([call])[0]
    expect(transition?.input).toEqual(expect.objectContaining({
      response: expect.objectContaining({
        state: expect.objectContaining({ status: "failed", error: expect.stringContaining("invalid ask output") })
      })
    }))
  })
})
