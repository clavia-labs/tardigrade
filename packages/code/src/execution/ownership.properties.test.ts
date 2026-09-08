import { expect, test } from "bun:test"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import { factsOf } from "./projections"

const ref = fc.record({
  seq: fc.integer({ min: 1, max: 100 }),
  component: fc.string({ minLength: 1, maxLength: 8 }),
  tag: fc.string({ minLength: 1, maxLength: 8 })
})
const execution = fc.record({
  ref,
  settled: fc.boolean(),
  calls: fc.array(fc.constantFrom("blocked", "ready", "returned"), { minLength: 1, maxLength: 4 })
})
const executions = fc.uniqueArray(execution, {
  minLength: 2, maxLength: 6,
  selector: (value) => JSON.stringify(value.ref)
})

const scenario = executions.chain((operations) => {
  const events: Event[] = operations.flatMap((operation, index) => [
    { type: "CodeDispatched", execId: "same", turn: "same", transitionRef: operation.ref, at: index + 1 },
    ...operation.calls.flatMap((state, ordinal): Event[] => [
      { type: "PackageCalled", callId: "same", executionRef: operation.ref, ordinal },
      { type: "BlockedOn", callId: "same", executionRef: operation.ref, ordinal, awaiting: `${index}:${ordinal}` },
      ...(state === "returned" ? [{ type: "PackageReturned", callId: "same", executionRef: operation.ref, ordinal }] : []),
      ...(state === "ready" ? [{ type: "ResponseReceived", id: `${index}:${ordinal}` }] : [])
    ]),
    ...(operation.settled ? [{ type: "CodeSettled", execId: "same", turn: "same", executionRef: operation.ref }] : [])
  ])
  return fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length })
    .map((shuffled) => ({ operations, events, shuffled }))
})

test("operation refs isolate colliding payload IDs through permutation, redelivery, and cold replay", () => {
  fc.assert(fc.property(scenario, ({ operations, events, shuffled }) => {
    const expected = operations.map((operation) => ({
      settled: operation.settled,
      called: true,
      open: operation.calls.filter((state) => state !== "returned").length,
      home: operation.calls.filter((state) => state === "ready").length
    }))
    for (const history of [events, shuffled, [...shuffled, ...events], JSON.parse(JSON.stringify(shuffled)) as Event[]]) {
      expect(factsOf(history).map((fact) => ({
        settled: fact.settled, called: fact.called, open: fact.open.size, home: fact.home.size
      }))).toEqual(expected)
    }
  }), { numRuns: 200 })
})
