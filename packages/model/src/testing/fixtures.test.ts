import { expect, test } from "bun:test"
import { providerEvents } from "./fixtures"

test("provider event fixtures do not share mutable values", () => {
  const first = providerEvents("openai", false) as Array<Record<string, unknown>>
  const second = providerEvents("openai", false)
  const added = first.find((event) => event.type === "response.output_item.added")!
  const done = first.find((event) => event.type === "response.output_item.done")!
  const addedItem = added.item as Record<string, unknown>

  addedItem.id = "changed"

  expect((done.item as Record<string, unknown>).id).toBe("rs_a")
  expect(second).toEqual(providerEvents("openai", false))
})
