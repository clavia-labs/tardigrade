import { expect, test } from "bun:test"
import { childKeyOf } from "../coordinate"
import { upcastThreadRequest, threadRequestOf } from "./upcast"

const target = { actor: "test", instance: "main", thread: "worker" }

test("historical requests preserve recorded lineage without rewriting history", () => {
  const stored = Object.freeze({ parentThread: "root", depth: 3, placement: "independent" })
  const metadata = upcastThreadRequest(stored)
  expect(metadata).toEqual({ parentThread: "root", depth: 3, placement: "independent" })
  expect(upcastThreadRequest(metadata)).toEqual(metadata)
  expect(threadRequestOf(target, stored)).toEqual({
    kind: "child", parent: { ...target, thread: "root" }, child: childKeyOf("worker"), placement: "independent"
  })
  expect(stored).toEqual({ parentThread: "root", depth: 3, placement: "independent" })
})

test("current creation inputs survive normalization and retain fork checkpoints", () => {
  const source = { ...target, thread: "root" }
  const requests = [
    { kind: "root" as const, coordinate: target },
    { kind: "root" as const, coordinate: target, fork: { source, seq: 12 } },
    { kind: "child" as const, parent: source, child: childKeyOf("worker"), maxDepth: 4, placement: "colocated" as const }
  ] as const
  for (const allocationRequest of requests) {
    const metadata = upcastThreadRequest({ allocationRequest })
    expect(threadRequestOf(target, metadata)).toEqual(allocationRequest)
    expect(upcastThreadRequest(metadata)).toEqual(metadata)
  }
  expect(upcastThreadRequest({ allocationRequest: requests[2] })).toMatchObject({ parentThread: "root", placement: "colocated" })
})

test("historical root requests retain only the known creation identity", () => {
  expect(threadRequestOf(target, {})).toEqual({ kind: "root", coordinate: target })
})
