import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Transport } from "@clavia/tardigrade-core/transport"
import { transition, type Reactor } from "@clavia/tardigrade-core/actor"
import { createHost } from "./host"
import type { AwaitEdge } from "./deadlock"
import { parseActorAddress } from "@clavia/tardigrade-core/communication/address"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { deliveryOf } from "@clavia/tardigrade-core/communication/delivery"

// The deadlock sentinel against toy reactors, package-pure. Each lane's
// body: on its brief, declare an await on its partner; on its await's
// reply (however it ends), settle and answer whoever awaits it. Two
// lanes awaiting each other is packages/core/tla/communication/Delivery.tla's
// DeliveryDeadlock trace: without the sentinel both rest forever;
// with it, one victim edge fails, the fallout cascades, and the whole
// knot settles.

const str = (v: unknown): string => String(v ?? "")

const has = (events: ReadonlyArray<Event>, type: string, id?: string): boolean =>
  events.some((e) => e.type === type && (id === undefined || str((e as { id?: unknown }).id) === id))

const knotKeys = (e: Event): string | undefined => {
  const v = e as { id?: unknown; callId?: unknown }
  if (e.type === "MessageReceived") return `msg:${str(v.id)}`
  if (e.type === "Awaiting") return `aw:${str(v.callId)}`
  if (e.type === "Settled") return "st:1"
  return undefined
}

const knotReactor = (me: string, partner: string): Reactor<Transport> =>
  (events) => {
    if (has(events, "Settled")) return []
    // A brief with no declared await: declare one.
    if (has(events, "MessageReceived", "brief") && !has(events, "Awaiting")) {
      return [
        transition({
          key: `aw:${me}.await`,
          input: { partner, callId: `${me}.await` },
          act: (input) =>
            Effect.succeed([{ type: "Awaiting", target: input.partner, callId: input.callId, at: 1 } as Event])
        })
      ]
    }
    // The awaited reply is home: settle enabled.
    if (!has(events, "MessageReceived", `${me}.await.reply`)) return []
    return [
      transition({
        key: "st:1",
        input: { partner },
        act: (input) =>
          Effect.gen(function* () {
            const transport = yield* Transport
            // Answer whoever awaits me, then settle.
            yield* transport.deliver(deliveryOf(
              linkOf(parseActorAddress(`mem:${me}`), parseActorAddress(`mem:${input.partner}`)),
              {
              type: "MessageReceived",
              id: `${input.partner}.await.reply`,
              outcome: "completed",
              text: "done",
              at: 2
              } as Event
            ))
            return [{ type: "Settled", at: 3 } as Event]
          })
      })
    ]
  }

const edgesOf = (lane: string, events: ReadonlyArray<Event>): ReadonlyArray<AwaitEdge> => {
  if (has(events, "Settled")) return []
  return events
    .filter((e) => e.type === "Awaiting")
    .filter(() => !has(events, "MessageReceived", `${lane}.await.reply`))
    .map((e) => ({
      from: lane,
      to: str((e as { target?: unknown }).target),
      callId: str((e as { callId?: unknown }).callId),
      replyId: `${lane}.await.reply`
    }))
}

const knot = (withSentinel: boolean) =>
  createHost<Transport>({
    actorFor: (lane) =>
      lane === "p" ? { reactors: [knotReactor("p", "c")], keyOf: knotKeys }
      : lane === "c" ? { reactors: [knotReactor("c", "p")], keyOf: knotKeys }
      : undefined,
    ...(withSentinel ? { edgesOf } : {})
  })

const brief: Event = { type: "MessageReceived", id: "brief", text: "go", at: 0 } as Event

describe("the deadlock sentinel", () => {
  test("without it, the knot rests forever, honestly", async () => {
    const h = knot(false)
    h.deliver("mem:p", brief)
    h.deliver("mem:c", brief)
    await h.drive()
    expect(h.resting()).toBe(true)
    expect(has(h.read("p"), "Settled")).toBe(false)
    expect(has(h.read("c"), "Settled")).toBe(false)
  })

  test("with it, one victim fails and the whole knot settles", async () => {
    const h = knot(true)
    h.deliver("mem:p", brief)
    h.deliver("mem:c", brief)
    await h.drive()
    expect(has(h.read("p"), "Settled")).toBe(true)
    expect(has(h.read("c"), "Settled")).toBe(true)
    // Exactly one member took the synthetic failure, and it names the cycle.
    const failures = [...h.read("p"), ...h.read("c")].filter(
      (e) => e.type === "MessageReceived" && String((e as { text?: unknown }).text ?? "").startsWith("deadlock:")
    )
    expect(failures).toHaveLength(1)
    expect(String((failures[0] as { text?: unknown }).text)).toContain("waits for")
  })
})
