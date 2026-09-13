import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { forkBatchFor, forkOutcomeOf, forkRootAllocation, isForkRefused, resolveForkCheckpoint, ForkRefused } from "./fork"

const root = { actor: "mem", instance: "main", thread: "root" } as const
const created = threadCreated(root, undefined, 1)
const message = { type: "MessageReceived", id: "m1", at: 2 } as Event
const destCreated = threadCreated({ ...root, thread: "experiment" }, undefined, 3)

const refusalOf = (run: () => unknown): ForkRefused["refusal"] | undefined => {
  try {
    run()
    return undefined
  } catch (failure) {
    return isForkRefused(failure) ? failure.refusal : undefined
  }
}

describe("forkBatchFor", () => {
  test("each refusal carries its kind", () => {
    expect(refusalOf(() => forkBatchFor([created, message], { source: root, seq: 2, dest: "experiment" }, 40))).toBeUndefined()
    expect(refusalOf(() => forkBatchFor([], { source: { ...root, thread: "ghost" }, seq: 1, dest: "x" }, 40))).toBe("unknown-source")
    expect(refusalOf(() => forkBatchFor([message], { source: root, seq: 1, dest: "x" }, 40))).toBe("unknown-source")
    expect(refusalOf(() => forkBatchFor([created, message], { source: root, seq: 1, dest: "root" }, 40))).toBe("checkpoint")
    expect(refusalOf(() => forkBatchFor([created, message], { source: root, seq: 9, dest: "x" }, 40))).toBe("checkpoint")
  })
})

describe("resolveForkCheckpoint", () => {
  test("a row passes through and an event id resolves to its last row", () => {
    const shared = { type: "ModelCalled", callId: "c1", at: 3 } as Event
    const returned = { type: "ModelReturned", callId: "c1", at: 4 } as Event
    expect(resolveForkCheckpoint([created, message, shared, returned], { seq: 3 })).toBe(3)
    expect(resolveForkCheckpoint([created, message, shared, returned], { event: "m1" })).toBe(2)
    expect(resolveForkCheckpoint([created, message, shared, returned], { event: "c1" })).toBe(4)
    expect(refusalOf(() => resolveForkCheckpoint([created, message], { event: "ghost" }))).toBe("checkpoint")
  })
})

describe("forkOutcomeOf", () => {
  test("a destination holding the same batch is existing, anything else is occupied", () => {
    const batch = forkBatchFor([created, message], { source: root, seq: 2, dest: "experiment" }, 40)
    expect(forkOutcomeOf([destCreated, ...batch], batch, "experiment")).toBe("existing")
    expect(refusalOf(() => forkOutcomeOf([destCreated, message], batch, "experiment"))).toBe("occupied")
    expect(refusalOf(() => forkOutcomeOf([destCreated], batch, "experiment"))).toBe("occupied")
  })
})

test("forkRootAllocation names a dest or mints a retry key", () => {
  expect(forkRootAllocation({ actor: "mem", instance: "main" }, "experiment")).toEqual({
    kind: "root",
    coordinate: { actor: "mem", instance: "main", thread: "experiment" }
  })
  const generated = forkRootAllocation({ actor: "mem", instance: "main" }, undefined)
  expect(generated.kind).toBe("root")
  expect(generated.coordinate.thread).toBe("")
  expect(generated.key).toEqual(expect.any(String))
})
