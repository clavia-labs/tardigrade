import { describe, expect, test } from "bun:test"

import { agentPath, DEFAULT_API_URL, problemOf, url, VoyagerError } from "./api"

// The two things the client decides on its own: where a call goes, and what a failure says. Both
// are pure, so neither needs a server. Everything else this module does is fetch.

describe("url", () => {
  test("drops undefined params and keeps the stated ones", () => {
    expect(url("/agents/a/events", { after: 40, limit: undefined }, DEFAULT_API_URL))
      .toBe("http://localhost:4111/agents/a/events?after=40")
  })

  test("a base with a trailing slash does not double it", () => {
    expect(url("/healthz", {}, "http://127.0.0.1:4111/")).toBe("http://127.0.0.1:4111/healthz")
  })

  test("an agent id is encoded into the path", () => {
    expect(agentPath("ag/one two")).toBe("/agents/ag%2Fone%20two")
  })
})

describe("problemOf", () => {
  test("a problem document surfaces its own title and detail", () => {
    const error = problemOf(404, "Not Found", {
      type: "https://tardigrade.dev/problems/unknown-agent",
      title: "Unknown Agent",
      status: 404,
      detail: 'No agent named "ghost" has ever existed.'
    })
    expect(error).toBeInstanceOf(VoyagerError)
    expect(error.title).toBe("Unknown Agent")
    expect(error.detail).toBe('No agent named "ghost" has ever existed.')
    expect(error.status).toBe(404)
  })

  test("a body that is not a problem document falls back to the status line", () => {
    const error = problemOf(502, "Bad Gateway", "<html>")
    expect(error.title).toBe("Bad Gateway")
    expect(error.detail).toBeUndefined()
    expect(error.status).toBe(502)
  })
})
