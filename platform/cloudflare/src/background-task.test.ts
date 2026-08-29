import { describe, expect, test } from "bun:test"
import { backgroundTaskOwnerOf, DEFAULT_BACKGROUND_TASK_OWNER, retainBackgroundTask } from "./background-task"

describe("background task ownership", () => {
  test("the default assigns background tasks to the host", () => {
    expect(backgroundTaskOwnerOf(undefined)).toBe(DEFAULT_BACKGROUND_TASK_OWNER)
  })

  test("a deployment overrides its worker fallback", () => {
    expect(backgroundTaskOwnerOf("request", "host")).toBe("request")
    expect(() => backgroundTaskOwnerOf("detached")).toThrow("must be \"host\" or \"request\"")
  })

  test("request ownership retains the task", () => {
    const retained: Array<Promise<unknown>> = []
    const task = Promise.resolve()
    retainBackgroundTask({ waitUntil: (value) => retained.push(value) }, "request", task)
    expect(retained).toEqual([task])
  })

  test("host ownership needs no request retention", () => {
    const retained: Array<Promise<unknown>> = []
    retainBackgroundTask({ waitUntil: (task) => retained.push(task) }, "host", Promise.resolve())
    expect(retained).toEqual([])
  })
})
