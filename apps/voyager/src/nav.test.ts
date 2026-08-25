import { describe, expect, test } from "bun:test"

import { routeOf } from "./nav"

describe("routeOf", () => {
  test("an unknown view does not hide the trace", () => {
    expect(routeOf("?thread=root&view=unknown").view).toBeUndefined()
  })

  test("the new thread surface is shareable", () => {
    expect(routeOf("?view=new").view).toBe("new")
  })
})
