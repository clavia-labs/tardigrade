import { describe, expect, test } from "bun:test"

import { routeOf } from "./nav"

describe("routeOf", () => {
  test("the API surface is a shareable view", () => {
    expect(routeOf("?actor=default&view=api")).toEqual({
      actor: "default",
      thread: undefined,
      view: "api",
      from: undefined,
      to: undefined
    })
  })

  test("an unknown view does not hide the trace", () => {
    expect(routeOf("?thread=root&view=unknown").view).toBeUndefined()
  })
})
