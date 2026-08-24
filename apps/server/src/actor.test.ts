import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { replyId } from "@clavia/tardigrade-core/message"
import { projection, projectionsOf, RESERVED_PROJECTIONS } from "@clavia/tardigrade-client/contract"

import { agentProjections, builtInActor } from "./actor"

// The actor's own declaration: what it says a thread can be asked beyond its log, and what the
// platform refuses to mount. The projections are pure functions of an event array, so the fixtures
// are event arrays, trimmed to the fields the reading looks at.

let clock = 0
const at = () => ++clock

const inbound = (id: string, text = "do the thing"): Event =>
  ({ type: "MessageReceived", id, text, at: at() }) as Event

const completed = (turn: string, output: string): Event =>
  ({ type: "TurnCompleted", turn, output, at: at() }) as Event

const failed = (turn: string, error: string): Event =>
  ({ type: "TurnFailed", turn, error, at: at() }) as Event

const requested = (turn: string, callId: string): Event =>
  ({ type: "BudgetRequested", turn, callId, reason: "more calls", amount: 5, at: at() }) as Event

const reply = (id: string, text = "done"): Event =>
  ({ type: "MessageReceived", id: replyId(id), text, outcome: "completed", at: at() }) as Event

const turns = agentProjections.turns

describe("the built-in actor", () => {
  test("declares the message method", () => {
    expect(Object.keys(builtInActor().methods)).toEqual(["message"])
  })
})

describe("the turns projection", () => {
  test("one entry per inbound message, with its boundary", () => {
    const log = [
      inbound("m1"),
      completed("m1", "42"),
      inbound("m2"),
      failed("m2", "boom"),
      inbound("m3")
    ]
    expect(turns.run(log, {})).toEqual([
      { turn: "m1", status: "completed", epoch: 0, output: "42" },
      { turn: "m2", status: "failed", epoch: 0, error: "boom" },
      { turn: "m3", status: "pending", epoch: 0 }
    ])
  })

  test("a reply message is not a turn", () => {
    const log = [inbound("m1"), reply("t1.0"), completed("m1", "42")]
    expect(turns.run(log, {}).map((view) => view.turn)).toEqual(["m1"])
  })

  test("an unanswered budget ask is parked", () => {
    const log = [inbound("m1"), requested("m1", "c1")]
    expect(turns.run(log, {})).toEqual([{ turn: "m1", status: "parked", epoch: 0 }])
  })

  // `at` is the projection's own declared parameter, so time travel is a query this actor accepts
  // rather than a mode the platform holds (contract.ts, projection).
  test("a prefix takes a turn back to pending", () => {
    const log = [inbound("m1"), completed("m1", "42")]
    expect(turns.run(log, {})[0]!.status).toBe("completed")
    expect(turns.run(log, { at: 1 })).toEqual([{ turn: "m1", status: "pending", epoch: 0 }])
    expect(turns.run(log, { at: 0 })).toEqual([])
  })
})

// The single lookup is a query on this projection rather than a route of its own, which is what
// lets the platform keep no turn-shaped handler at all (apps/server/src/api.ts).
describe("reading one turn", () => {
  test("`turn` narrows the answer to that entry", () => {
    const log = [inbound("m1"), completed("m1", "42"), inbound("m2"), failed("m2", "boom")]
    expect(turns.run(log, { turn: "m2" })).toEqual([{ turn: "m2", status: "failed", epoch: 0, error: "boom" }])
  })

  test("a turn nobody was asked to serve matches nothing", () => {
    const log = [inbound("m1"), completed("m1", "42")]
    expect(turns.run(log, { turn: "m9" })).toEqual([])
  })

  test("`turn` and `at` narrow together", () => {
    const log = [inbound("m1"), completed("m1", "42")]
    expect(turns.run(log, { turn: "m1", at: 1 })).toEqual([{ turn: "m1", status: "pending", epoch: 0 }])
  })

  // The epoch is on the wire because resuming stamps the next one, and a resumed turn reads the
  // epoch its active attempt belongs to (packages/agent/src/resume.ts, resumeTurn).
  test("a resumed turn reads the epoch its active attempt belongs to", () => {
    const log = [
      inbound("m1"),
      failed("m1", "boom"),
      { type: "TurnResumed", turn: "m1", failedEpoch: 0, epoch: 1, at: at() } as Event
    ]
    expect(turns.run(log, { turn: "m1" })).toEqual([{ turn: "m1", status: "pending", epoch: 1 }])
  })
})

describe("declaring projections", () => {
  // The log is not a projection of itself, so the two names that read it are refused where the
  // declaration is written rather than where a request arrives (contract.ts, RESERVED_PROJECTIONS).
  test("a projection may not claim a reserved name", () => {
    for (const reserved of RESERVED_PROJECTIONS) {
      expect(() =>
        projectionsOf({
          [reserved]: projection({
            params: {},
            result: Schema.Array(Schema.String),
            run: () => []
          })
        })
      ).toThrow(`a projection may not be named ${JSON.stringify(reserved)}`)
    }
  })

  test("a name the log does not own is declared without complaint", () => {
    const declared = projectionsOf({
      streams: projection({ params: {}, result: Schema.Array(Schema.String), run: () => [] })
    })
    expect(Object.keys(declared)).toEqual(["streams"])
  })

  test("the reserved names are the log's own two routes", () => {
    expect([...RESERVED_PROJECTIONS].sort()).toEqual(["events", "stream"])
  })
})
