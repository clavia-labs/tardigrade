import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { effect, type Reactor } from "@clavia/tardigrade-core/reconciliation"
import { createHost, type HostOptions } from "./host"
import { parseThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import { linkOf } from "@clavia/tardigrade-core/communication/link"
import { envelopeOf } from "@clavia/tardigrade-core/communication/envelope"

// The driver's confluence property: the order the driver services dirty
// threads must not change any outcome. This is the driver-level bag law,
// and the assumption under Driver.tla's any-order visits. Outcomes are
// compared as fingerprints, the per-thread set of (type, id) pairs, since
// service order legitimately changes arrival order and timestamps.

const RALLY = 5

const str = (v: unknown): string => String(v ?? "")

const rallyKeys = (e: Event): string | undefined => {
  const v = e as { id?: unknown }
  if (e.type === "MessageReceived") return `msg:${str(v.id)}`
  if (e.type === "Answered") return `an:${str(v.id)}`
  return undefined
}

const playerReactor = (me: string, opponent: string): Reactor<Router> =>
  (events) => {
    const answered = new Set(
      events.filter((e) => e.type === "Answered").map((e) => str((e as { id?: unknown }).id))
    )
    const pending = events.find(
      (e) => e.type === "MessageReceived" && !answered.has(str((e as { id?: unknown }).id))
    ) as { id?: unknown; n?: unknown } | undefined
    if (pending === undefined) return []
    const n = Number(pending.n ?? 0)
    return [
      effect({
        key: `an:${str(pending.id)}`,
        input: { id: str(pending.id), n },
        act: (input) =>
          Effect.gen(function* () {
            const router = yield* Router
            if (input.n < RALLY) {
              yield* router.send(envelopeOf(
                linkOf(parseThreadAddress(`mem:main:${me}`), parseThreadAddress(`mem:main:${opponent}`)),
                {
                type: "MessageReceived",
                id: `${me}-${input.n + 1}`,
                n: input.n + 1,
                at: input.n + 1
                } as Event
              , me === "a" || me === "b" ? { parent: parseThreadAddress(`mem:main:${me}`), depth: 1 } : undefined))
            }
            return [{ type: "Answered", id: input.id, at: input.n } as Event]
          })
      })
    ]
  }

// Four players, two interleaved rallies, so several threads are dirty at
// once and the schedule genuinely matters.
const THREADS = ["a", "b", "c", "d"]

const scenario = (pick: HostOptions<Router>["pick"]) => {
  const host = createHost<Router>({
    actorFor: (thread) => {
      const i = THREADS.indexOf(thread)
      if (i === -1) return undefined
      const partner = THREADS[(i + 2) % 4]!
      return { reactors: [playerReactor(thread, partner)], keyOf: rallyKeys }
    },
    ...(pick === undefined ? {} : { pick })
  })
  host.commitRoot("mem:main:a", { type: "MessageReceived", id: "serve-1", n: 0, at: 0 } as Event)
  host.commitRoot("mem:main:b", { type: "MessageReceived", id: "serve-2", n: 0, at: 0 } as Event)
  return host
}

const fingerprint = (host: ReturnType<typeof scenario>): string =>
  JSON.stringify(
    THREADS.map((thread) => [
      thread,
      host
        .read(thread)
        .map((e) => `${e.type}:${str((e as { id?: unknown }).id)}`)
        .sort()
    ])
  )

describe("driver confluence", () => {
  test("any service order reaches the same quiescent outcome", async () => {
    const baseline = scenario(undefined)
    await baseline.drive()
    const expected = fingerprint(baseline)

    await fc.assert(
      fc.asyncProperty(fc.infiniteStream(fc.nat()), async (seeds) => {
        const shuffled = scenario((dirty) => {
          const threads = [...dirty]
          return threads[seeds.next().value % threads.length]!
        })
        await shuffled.drive()
        expect(shuffled.resting()).toBe(true)
        expect(fingerprint(shuffled)).toBe(expected)
      }),
      { numRuns: 200 }
    )
  })
})
