import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { codeEventIdentity, codeKeys } from "./events"
import { factsOf, workOwed } from "./projections"

// Provider execution ids and package call ids are unique only inside one model turn, so every
// projection fact keys by the (turn, id) pair and an unstamped event keeps its bare id.

const dispatched = (execId: string, turn: string, at: number): Event =>
  ({ type: "CodeDispatched", execId, code: "work()", turn, at })

describe("execution identity across turns", () => {
  test("reused execution ids across turns settle separately", () => {
    const events: ReadonlyArray<Event> = [
      dispatched("e1", "t1", 1),
      dispatched("e1", "t2", 2),
      { type: "CodeSettled", execId: "e1", turn: "t1", at: 3 }
    ]
    const facts = factsOf(events)
    expect(facts).toHaveLength(2)
    expect(facts.find((fact) => fact.turn === "t1")?.settled).toBe(true)
    expect(facts.find((fact) => fact.turn === "t2")?.settled).toBe(false)
    expect(workOwed(events)?.turn).toBe("t2")
  })

  test("a package call joins the execution in its own turn only", () => {
    const events: ReadonlyArray<Event> = [
      dispatched("e1", "t1", 1),
      dispatched("e1", "t2", 2),
      { type: "PackageCalled", callId: "e1.0", name: "agents.run", turn: "t2", at: 3 },
      { type: "BlockedOn", callId: "e1.0", awaiting: "e1.0.reply", turn: "t2", at: 4 }
    ]
    const facts = factsOf(events)
    expect(facts.find((fact) => fact.turn === "t1")?.called).toBe(false)
    const inTurn = facts.find((fact) => fact.turn === "t2")
    expect(inTurn?.called).toBe(true)
    expect([...inTurn?.open ?? []]).toEqual(["e1.0"])
  })

  test("an unstamped execution keeps its bare identity", () => {
    const events: ReadonlyArray<Event> = [
      { type: "CodeDispatched", execId: "e1", code: "work()", at: 1 },
      { type: "CodeSettled", execId: "e1", at: 2 }
    ]
    expect(factsOf(events)).toMatchObject([{ execId: "e1", settled: true }])
    expect(workOwed(events)).toBeUndefined()
  })

  test("codeKeys scope the recorded pair by turn and keep bare ids for unstamped events", () => {
    expect(codeKeys.keyOf({ type: "CodeDispatched", execId: "e1", turn: "t1" }))
      .toBe(`cd:${codeEventIdentity("t1", "e1")}`)
    expect(codeKeys.keyOf({ type: "CodeDispatched", execId: "e1" })).toBe("cd:e1")
    expect(codeKeys.keyOf({ type: "PackageReturned", callId: "e1.0", turn: "t1" }))
      .toBe(`pr:${codeEventIdentity("t1", "e1.0")}`)
    expect(codeKeys.keyOf({ type: "BlockedOn", callId: "e1.0", turn: "t1" }))
      .toBe(`bk:${codeEventIdentity("t1", "e1.0")}`)
  })
})