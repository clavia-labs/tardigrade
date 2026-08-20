import { describe, expect, test } from "bun:test"

import { PROBLEM_TYPE_BASE } from "./contract"
import { isProblem, problemOf, ProblemError } from "./problem"

// What a failure says, which is pure and needs no server.

describe("problemOf", () => {
  test("a problem document surfaces all four fields", () => {
    const error = problemOf(404, {
      type: `${PROBLEM_TYPE_BASE}unknown-agent`,
      title: "Unknown Agent",
      status: 404,
      detail: 'No agent named "ghost" has ever existed.'
    }, "Not Found")
    expect(error).toBeInstanceOf(ProblemError)
    expect(error.type).toBe(`${PROBLEM_TYPE_BASE}unknown-agent`)
    expect(error.title).toBe("Unknown Agent")
    expect(error.status).toBe(404)
    expect(error.detail).toBe('No agent named "ghost" has ever existed.')
    expect(error.message).toBe('Unknown Agent: No agent named "ghost" has ever existed.')
  })

  test("the document's own status wins over the response's", () => {
    const error = problemOf(200, { type: "t", title: "Resume Refused", status: 409 }, "OK")
    expect(error.status).toBe(409)
    expect(error.detail).toBeUndefined()
  })

  test("a body that is not a problem document falls back to the status line", () => {
    const error = problemOf(502, "<html>", "Bad Gateway")
    expect(error.title).toBe("Bad Gateway")
    expect(error.type).toBeUndefined()
    expect(error.detail).toBeUndefined()
    expect(error.status).toBe(502)
  })
})

describe("isProblem", () => {
  test("the three required fields are what makes a document one", () => {
    expect(isProblem({ type: "t", title: "T", status: 400 })).toBe(true)
    expect(isProblem({ title: "T", status: 400 })).toBe(false)
    expect(isProblem(null)).toBe(false)
    expect(isProblem("not-json")).toBe(false)
  })
})
