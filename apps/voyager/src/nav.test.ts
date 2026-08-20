import { describe, expect, test } from "bun:test"

import { routeOf } from "./nav"

describe("routeOf", () => {
  test("the API surface is a shareable view", () => {
    expect(routeOf("?actor=default&view=api")).toEqual({
      actor: "default",
      thread: undefined,
      view: "api",
      operation: undefined,
      from: undefined,
      to: undefined
    })
  })

  test("an unknown view does not hide the trace", () => {
    expect(routeOf("?thread=root&view=unknown").view).toBeUndefined()
  })

  test("an API operation survives a refresh", () => {
    expect(routeOf("?view=api&operation=get%3A%2Fhealthz").operation).toBe("get:/healthz")
  })
})
