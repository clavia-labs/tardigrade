import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import type { Event } from "@tardigrade/core/event"
import { Router } from "@tardigrade/core/router"
import { transition, type Reactor } from "@tardigrade/core/actor"
import { createHost, type HostOptions } from "./host"

// The driver's confluence property: the order the driver services dirty
// lanes must not change any outcome. This is the driver-level bag law,
// and the assumption under Driver.tla's any-order visits. Outcomes are
// compared as fingerprints, the per-lane set of (type, id) pairs, since
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
      transition({
        key: `an:${str(pending.id)}`,
        input: { id: str(pending.id), n },
        act: (input) =>
          Effect.gen(function* () {
            const router = yield* Router
            if (input.n < RALLY) {
              yield* router.deliver(`mem:${opponent}`, {
                type: "MessageReceived",
                id: `${me}-${input.n + 1}`,
                n: input.n + 1,
                at: input.n + 1
              } as Event)
            }
            return [{ type: "Answered", id: input.id, at: input.n } as Event]
          })
      })
    ]
  }

// Four players, two interleaved rallies, so several lanes are dirty at
// once and the schedule genuinely matters.
const LANES = ["a", "b", "c", "d"]

const scenario = (pick: HostOptions<Router>["pick"]) => {
  const host = createHost<Router>({
    actorFor: (lane) => {
      const i = LANES.indexOf(lane)
      if (i === -1) return undefined
      const partner = LANES[(i + 2) % 4]!
      return { reactors: [playerReactor(lane, partner)], keyOf: rallyKeys }
    },
    ...(pick === undefined ? {} : { pick })
  })
  host.deliver("mem:a", { type: "MessageReceived", id: "serve-1", n: 0, at: 0 } as Event)
  host.deliver("mem:b", { type: "MessageReceived", id: "serve-2", n: 0, at: 0 } as Event)
  return host
}

const fingerprint = (host: ReturnType<typeof scenario>): string =>
  JSON.stringify(
    LANES.map((lane) => [
      lane,
      host
        .read(lane)
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
          const lanes = [...dirty]
          return lanes[seeds.next().value % lanes.length]!
        })
        await shuffled.drive()
        expect(shuffled.resting()).toBe(true)
        expect(fingerprint(shuffled)).toBe(expected)
      }),
      { numRuns: 200 }
    )
  })
})
