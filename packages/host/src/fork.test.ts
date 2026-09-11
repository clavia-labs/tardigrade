import { describe, expect, test } from "bun:test"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import type { Event } from "@clavia/tardigrade-core/event"
import { forkCopyPlan, forkRootAllocation } from "./fork"

const created = threadCreated({ actor: "mem", instance: "main", thread: "root" }, undefined, 1)
const message = { type: "MessageReceived", id: "m1", at: 2 } as Event
const destCreated = threadCreated({ actor: "mem", instance: "main", thread: "experiment" }, undefined, 3)

describe("forkCopyPlan", () => {
  test("a fresh dest receives the prefix and ThreadForked", () => {
    const plan = forkCopyPlan([created, message], [destCreated], {
      source: "root",
      until: 2,
      dest: "experiment",
      forkedAt: 40
    })
    expect("events" in plan).toBe(true)
    if ("events" in plan) {
      expect(plan.events.map((event) => event.type)).toEqual(["MessageReceived", "ThreadForked"])
    }
  })

  test("a matching dest is returned without a second copy", () => {
    const first = forkCopyPlan([created, message], [destCreated], {
      source: "root",
      until: "m1",
      dest: "experiment",
      forkedAt: 40
    })
    if (!("events" in first)) throw new Error("expected copy")
    const dest = [destCreated, ...first.events]
    const again = forkCopyPlan([created, message], dest, {
      source: "root",
      until: "m1",
      dest: "experiment",
      forkedAt: 41
    })
    expect(again).toEqual({ existing: true })
  })

  test("an occupied dest that is not this fork is refused", () => {
    expect(() => forkCopyPlan([created, message], [destCreated, message], {
      source: "root",
      until: 2,
      dest: "experiment",
      forkedAt: 40
    })).toThrow("already has a log")
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
