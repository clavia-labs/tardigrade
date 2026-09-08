import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { boundaryId, messageSubjects, replySubjectOf } from "../interaction/provider-message"
import {
  assertEventSubjects,
  assertSubjectLookup,
  composeSubjects,
  MAX_SUBJECT_LENGTH,
  MAX_SUBJECTS_PER_EVENT,
  MAX_SUBJECTS_PER_LOOKUP,
  type SubjectFragment
} from "./subjects"

const customSubjects: SubjectFragment = {
  prefixes: ["custom:"],
  subjectsOf: (event) => event.type === "Custom" && typeof event.id === "string" ? [`custom:${event.id}`] : []
}

describe("composeSubjects", () => {
  test("subjects compose in fragment order and unrelated events have none", () => {
    const subjectsOf = composeSubjects(messageSubjects, customSubjects)
    expect(subjectsOf({ type: "MessageReceived", id: "m1", text: "", at: 0 })).toEqual(["msg:m1"])
    expect(subjectsOf({ type: "Custom", id: "x", at: 0 })).toEqual(["custom:x"])
    expect(subjectsOf({ type: "ModelCalled", at: 0 })).toEqual([])
  })

  test("duplicate prefixes fail during composition", () => {
    const rival: SubjectFragment = { prefixes: ["custom:"], subjectsOf: () => [] }
    expect(() => composeSubjects(customSubjects, rival)).toThrow('subject prefix "custom:" claimed by fragments 0 and 1')
  })

  test("lookup bounds reject empty, oversized, and over-count subject sets", () => {
    expect(() => assertSubjectLookup([])).toThrow()
    expect(() => assertSubjectLookup(["x".repeat(MAX_SUBJECT_LENGTH + 1)])).toThrow()
    expect(() => assertSubjectLookup(Array.from({ length: MAX_SUBJECTS_PER_LOOKUP + 1 }, (_, index) => `x:${index}`))).toThrow()
    expect(() => assertSubjectLookup(["x"])).not.toThrow()
  })

  test("event bounds allow no subjects but reject more than eight", () => {
    expect(() => assertEventSubjects([])).not.toThrow()
    const tooMany = Array.from({ length: MAX_SUBJECTS_PER_EVENT + 1 }, (_, index) => `x:${index}`)
    expect(() => assertEventSubjects(tooMany)).toThrow()
  })
})

describe("messageSubjects", () => {
  test("a plain message is addressable by id", () => {
    expect(messageSubjects.subjectsOf({ type: "MessageReceived", id: "m1", text: "go", at: 0 })).toEqual(["msg:m1"])
    expect(messageSubjects.subjectsOf({ type: "MessageReceived", text: "no id", at: 0 })).toEqual([])
    expect(messageSubjects.subjectsOf({ type: "ToolCalled", callId: "c1", at: 0 })).toEqual([])
  })

  test("every reply round supersedes the same outbound subject", () => {
    expect(replySubjectOf(boundaryId("call-1", 0))).toBe("reply:call-1")
    expect(replySubjectOf(boundaryId("call-1", 2))).toBe("reply:call-1")
    expect(replySubjectOf("m1")).toBeUndefined()
    const reply: Event = { type: "MessageReceived", id: "call-1.reply", text: "done", at: 0 }
    expect(messageSubjects.subjectsOf(reply)).toEqual(["reply:call-1"])
    const response: Event = {
      type: "ResponseReceived",
      id: "call-1.reply.1",
      method: "message",
      call: "call-1",
      status: "completed",
      from: "a:main:t1",
      at: 0
    }
    expect(messageSubjects.subjectsOf(response)).toEqual(["reply:call-1"])
  })
})
