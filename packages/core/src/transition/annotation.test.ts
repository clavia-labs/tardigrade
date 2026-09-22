import { expect, test } from "bun:test"
import { Effect } from "effect"
import { eventAt } from "../event"
import { annotateTransition, bindTransitionContext, concurrentTransition, validateTransitions } from "./transition"

const source = Symbol("source")

test("annotations retain intent ownership and completion identity", () => {
  const context = bindTransitionContext(eventAt({ type: "Requested" }, 1), "child")
  const original = context.intent("work", { type: "Done" })
  const annotated = annotateTransition(original, source, { callId: "a" })
  expect(annotated[source]).toEqual({ callId: "a" })
  expect(annotated.key).toBe(original.key)
  expect(annotated.kind).toBe("intent")
  if (annotated.kind !== "intent") throw new Error("expected intent")
  expect(annotated.events).toBe(original.events)
  expect(context.matches("work", annotated.events(annotated.input, 0)[0]!)).toBe(true)
  expect(validateTransitions([annotated], "child")).toEqual([annotated])
  expect(() => validateTransitions([annotated], "other")).toThrow("belongs to component")
  expect(Object.isFrozen(annotated)).toBe(true)
  expect(source in original).toBe(false)
})

test("effect concurrency decoration preserves annotations and ownership", () => {
  const context = bindTransitionContext(eventAt({ type: "Requested" }, 1), "child")
  const original = context.effect("work", { input: undefined, act: () => Effect.succeed({ type: "Done" }) })
  const annotated = annotateTransition(original, source, { callId: "a" })
  if (annotated.kind !== "effect") throw new Error("expected effect")
  const concurrent = concurrentTransition(annotated)
  expect(Reflect.get(concurrent, source)).toEqual({ callId: "a" })
  expect(concurrent.act).toBe(original.act)
  expect(validateTransitions([concurrent], "child")).toEqual([concurrent])
})
