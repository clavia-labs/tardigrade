import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { actorIdOf, type ActorId } from "@clavia/tardigrade-core/communication/endpoint"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { threadCreated } from "@clavia/tardigrade-core/thread"
import { createHost } from "./host"

interface GraphSpec {
  readonly participants: ReadonlyArray<number>
  readonly edges: ReadonlyArray<{ readonly source: number; readonly target: number }>
}

const graphArbitrary: fc.Arbitrary<GraphSpec> = fc.uniqueArray(fc.integer({ min: 0, max: 30 }), {
  minLength: 2,
  maxLength: 8
}).chain((participants) => {
  const edges = participants.flatMap((source) =>
    participants.filter((target) => target !== source).map((target) => ({ source, target }))
  )
  return fc.subarray(edges, { minLength: 1, maxLength: Math.min(20, edges.length) }).map((selected) => ({
    participants,
    edges: selected
  }))
})

const identityOf = (id: number): ActorId => actorIdOf("graph", `participant-${id}`)

describe("host communication over participant graphs", () => {
  test("redelivering every graph edge commits each linked message once", async () => {
    await fc.assert(
      fc.asyncProperty(graphArbitrary, async (graph) => {
        const host = createHost({ principal: "graph", actorFor: () => undefined })
        for (const participant of graph.participants) {
          const identity = identityOf(participant)
          host.seed(identity.thread, [threadCreated(identity, undefined, 0)])
        }
        const envelopes = graph.edges.map((edge, index) =>
          envelopeOf(
            linkOf(identityOf(edge.source), identityOf(edge.target)),
            { type: "MessageReceived", id: `edge-${index}`, text: "hello", at: index } as Event
          )
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const router = yield* Router
            for (const envelope of envelopes) {
              yield* router.send(envelope)
              yield* router.send(envelope)
            }
          }).pipe(Effect.provide(host.router))
        )
        for (const [index, edge] of graph.edges.entries()) {
          const events = host.read(identityOf(edge.target).thread)
          const landed = events.filter((event) =>
            event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === `edge-${index}`
          )
          expect(landed).toHaveLength(1)
          expect((landed[0] as { readonly link?: unknown }).link).toEqual(envelopes[index]!.link)
        }
      }),
      { numRuns: 200 }
    )
  })
})
