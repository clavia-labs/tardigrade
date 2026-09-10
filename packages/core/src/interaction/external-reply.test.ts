import { expect, test } from "bun:test"
import { actorFromProjections } from "../runtime/definition"
import { actorRuntimeOf } from "../runtime/actor"
import { methodTimeoutKeys } from "./timeout"
import { ExternalReplyReceived, externalReplyKeys, externalReplyReceived } from "./external-reply"

test("external replies validate and keep identity by awaited id", () => {
  const first = externalReplyReceived({ id: "native:one", at: 1 })
  const second = externalReplyReceived({ id: "native:two", at: 2 })
  expect(first).toEqual({ type: "ExternalReplyReceived", id: "native:one", at: 1 })
  expect(externalReplyKeys.keyOf(first)).toBe("external-reply:native:one")
  expect(externalReplyKeys.keyOf(second)).toBe("external-reply:native:two")
  expect(externalReplyKeys.keyOf(externalReplyReceived({ id: "native:one", at: 3 }))).toBe(externalReplyKeys.keyOf(first))
  expect(methodTimeoutKeys.keyOf(first)).toBeUndefined()
  expect(() => externalReplyReceived({ id: "", at: 1 })).toThrow()
  expect(() => externalReplyReceived({ id: "native:one", at: Number.NaN })).toThrow()
  expect(() => externalReplyReceived({ id: "native:one", at: Number.POSITIVE_INFINITY })).toThrow()
  expect(externalReplyKeys.keyOf({ type: "ExternalReplyReceived", id: "native:one" })).toBeUndefined()
  expect(externalReplyKeys.keyOf({ type: "ExternalReplyReceived", id: "", at: 1 })).toBeUndefined()
  expect(ExternalReplyReceived).toBeDefined()
})

test("actor runtimes include external reply identity", () => {
  const runtime = actorFromProjections({ transitions: [], keyOf: () => undefined })
  const compiled = actorRuntimeOf({ name: "external-reply-test", methods: {}, components: [] })
  const events = [
    externalReplyReceived({ id: "native:one", at: 1 }),
    externalReplyReceived({ id: "native:two", at: 1 }),
    externalReplyReceived({ id: "native:one", at: 2 })
  ]
  expect(events.map(runtime.keyOf)).toEqual([
    "external-reply:native:one",
    "external-reply:native:two",
    "external-reply:native:one"
  ])
  expect(new Set(events.map(compiled.keyOf))).toEqual(new Set([
    "external-reply:native:one",
    "external-reply:native:two"
  ]))
})
