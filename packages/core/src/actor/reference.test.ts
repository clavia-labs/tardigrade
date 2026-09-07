import { expect, test } from "bun:test"
import { Effect } from "effect"
import { defineActor } from "./definition"
import { bindThreadMethods, targetCoordinate, threadTarget, type ThreadTarget } from "./reference"
import { ThreadAllocator } from "./allocation"

const actor = defineActor("tardie", {}, [])
const coordinate = { actor: "tardie", instance: "rick", thread: "main" }

test("references expose coordinate and the deprecated address alias", () => {
  const target = threadTarget(actor, "rick", "main")
  expect(target.address).toBe(target.coordinate)
  const legacy: ThreadTarget = { address: coordinate, methods: {} }
  const ref = bindThreadMethods(legacy)
  expect(ref.coordinate).toBe(coordinate)
  expect(ref.address).toBe(ref.coordinate)
  expect(targetCoordinate(legacy)).toBe(coordinate)
})

test("conflicting coordinate and address fields are rejected", () => {
  const target = { coordinate, address: { ...coordinate, thread: "other" }, methods: {} }
  expect(() => targetCoordinate(target)).toThrow("must agree")
  expect(() => bindThreadMethods(target)).toThrow("must agree")
})

test("child allocation accepts coordinates, references, and legacy targets", async () => {
  const ref = bindThreadMethods({ coordinate, methods: {} })
  for (const parent of [coordinate, ref, { address: coordinate, methods: {} }]) {
    const child = await Effect.runPromise(actor.allocateChildThread({ parent, name: "researcher" }).pipe(
      Effect.provideService(ThreadAllocator, { allocate: (request) => {
        expect(request.kind).toBe("child")
        if (request.kind !== "child") throw new Error("expected child")
        expect(request.parent).toEqual(coordinate)
        return Effect.succeed({ ...request.parent, thread: "researcher" })
      } })
    ))
    expect(child.coordinate).toEqual({ ...coordinate, thread: "researcher" })
    expect(child.address).toBe(child.coordinate)
  }
})
