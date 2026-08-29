import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fc from "fast-check"
import type { Event } from "../log/event"
import { mappedDirectory } from "./directory"
import { threadAddressOf, type ThreadAddress } from "./endpoint"
import { envelopeOf, isActorEnvelope, type ActorEnvelope } from "./envelope"
import { linkOf, reverseLink } from "./link"
import { boundaryEvent, boundaryId, type MessageReceived } from "./message"
import { directoryRoute, sendThrough, type TransportRoute } from "./router"
import type { Transport } from "./transport"

type TransportName = "local" | "durable-object"

interface ParticipantSpec {
  readonly id: number
  readonly transport: TransportName
  readonly node: number
}

interface EdgeSpec {
  readonly source: number
  readonly target: number
}

interface GraphSpec {
  readonly participants: ReadonlyArray<ParticipantSpec>
  readonly edges: ReadonlyArray<EdgeSpec>
}

interface PhysicalDestination {
  readonly node: number
  readonly identity: ThreadAddress
}

interface Sent {
  readonly transport: TransportName
  readonly destination: PhysicalDestination
  readonly envelope: ActorEnvelope
}

const graphArbitrary: fc.Arbitrary<GraphSpec> = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 0, max: 30 }),
    transport: fc.constantFrom<TransportName>("local", "durable-object"),
    node: fc.integer({ min: 0, max: 5 })
  }),
  { selector: (participant) => participant.id, minLength: 2, maxLength: 7 }
).chain((participants) => {
  const pairs = participants.flatMap((source) =>
    participants
      .filter((target) => target.id !== source.id)
      .map((target) => ({ source: source.id, target: target.id }))
  )
  return fc.subarray(pairs, { minLength: 1, maxLength: Math.min(18, pairs.length) }).map((edges) => ({
    participants,
    edges
  }))
})

const identityOf = (id: number): ThreadAddress => threadAddressOf("graph", "main", `participant-${id}`)

const routingFor = (participants: ReadonlyArray<ParticipantSpec>): {
  readonly routes: ReadonlyArray<TransportRoute>
  readonly sent: Array<Sent>
} => {
  const byId = new Map(participants.map((participant) => [participant.id, participant]))
  const sent: Array<Sent> = []
  const transport = (name: TransportName): Transport<PhysicalDestination, ActorEnvelope> => ({
    name,
    send: (destination, envelope) => Effect.sync(() => void sent.push({ transport: name, destination, envelope }))
  })
  const route = (name: TransportName): TransportRoute =>
    directoryRoute(
      transport(name),
      mappedDirectory<ThreadAddress, PhysicalDestination>((identity) => {
        const participant = byId.get(Number(identity.thread.slice("participant-".length)))
        return participant?.transport === name ? { node: participant.node, identity } : undefined
      }),
      isActorEnvelope,
      (envelope) => envelope.link.target
    )
  return { routes: [route("local"), route("durable-object")], sent }
}

const assertRouted = async (
  participants: ReadonlyArray<ParticipantSpec>,
  envelopes: ReadonlyArray<ActorEnvelope>
): Promise<void> => {
  const { routes, sent } = routingFor(participants)
  await Effect.runPromise(Effect.forEach(envelopes, (envelope) => sendThrough(routes, envelope), { discard: true }))
  expect(sent).toHaveLength(envelopes.length)
  const byId = new Map(participants.map((participant) => [participant.id, participant]))
  for (const envelope of envelopes) {
    const id = String((envelope.event as { readonly id?: unknown }).id)
    const carried = sent.find((entry) => String((entry.envelope.event as { readonly id?: unknown }).id) === id)
    const target = byId.get(Number(envelope.link.target.thread.slice("participant-".length)))!
    expect(carried?.envelope).toBe(envelope)
    expect(carried?.transport).toBe(target.transport)
    expect(carried?.destination).toEqual({ node: target.node, identity: envelope.link.target })
    expect(carried?.envelope.link).toEqual(envelope.link)
  }
}

describe("communication over participant graphs", () => {
  test("every graph edge resolves once and carries its envelope unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(graphArbitrary, async (graph) => {
        const envelopes: ReadonlyArray<ActorEnvelope> = graph.edges.map((edge, index) =>
          envelopeOf(
            linkOf(identityOf(edge.source), identityOf(edge.target)),
            { type: "MessageReceived", id: `edge-${index}`, text: `from ${edge.source}`, at: index } as Event
          )
        )
        await assertRouted(graph.participants, envelopes)
      }),
      { numRuns: 250 }
    )
  })

  test("a run and its reciprocal budget call each return one terminal", async () => {
    await fc.assert(
      fc.asyncProperty(graphArbitrary, async (graph) => {
        const reports: ActorEnvelope[] = []
        for (const [index, edge] of graph.edges.entries()) {
          const run = `run-${index}`
          const budget = `budget-${index}`
          const runLink = linkOf(identityOf(edge.source), identityOf(edge.target))
          const budgetLink = reverseLink(runLink)
          const ids = new Set<string>()
          for (const [call, accepted] of [[run, runLink], [budget, budgetLink]] as const) {
            const returned = reverseLink(accepted)
            const event: MessageReceived = boundaryEvent({
              turn: call,
              round: 0,
              text: "done",
              outcome: "completed",
              from: `${returned.source.actor}:${returned.source.thread}`,
              at: index
            })
            expect(event.id).toBe(boundaryId(call, 0))
            ids.add(event.id)
            const report = envelopeOf(returned, event)
            expect(reverseLink(report.link)).toEqual(accepted)
            expect(report.link.target).toEqual(accepted.source)
            reports.push(report)
          }
          expect(ids).toEqual(new Set([boundaryId(run, 0), boundaryId(budget, 0)]))
        }
        await assertRouted(graph.participants, reports)
      }),
      { numRuns: 250 }
    )
  })
})
