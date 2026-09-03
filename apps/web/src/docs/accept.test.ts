import { describe, expect, test } from "bun:test"

import { wantsMarkdown } from "./accept"

describe("docs content negotiation", () => {
  test("ambiguous clients receive HTML", () => {
    expect(wantsMarkdown(null)).toBe(false)
    expect(wantsMarkdown("*/*")).toBe(false)
    expect(wantsMarkdown("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(false)
  })

  test("explicit Markdown preferences receive Markdown", () => {
    expect(wantsMarkdown("text/markdown")).toBe(true)
    expect(wantsMarkdown("text/markdown,text/html;q=0.5")).toBe(true)
  })

  test("unsupported media types are refused", () => {
    expect(wantsMarkdown("application/json")).toBeUndefined()
  })
})
