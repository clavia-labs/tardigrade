import { expect, test } from "bun:test"
import { childCreated } from "@clavia/tardigrade-core/interaction/relations"
import { legacyChildHandle } from "./agents-compat"

test("legacy handles resolve one recorded dispatch and reject missing or ambiguous owners", () => {
  const parent = { actor: "agent", instance: "main", thread: "root" }
  const first = childCreated("c1", { ...parent, thread: "first" }, { parent, depth: 1 }, 1, "turn-a")
  const second = childCreated("c1", { ...parent, thread: "second" }, { parent, depth: 1 }, 2, "turn-b")
  expect(legacyChildHandle([first], "c1")).toEqual(first)
  expect(legacyChildHandle([], "c1")).toHaveProperty("error")
  expect(legacyChildHandle([first, second], "c1")).toHaveProperty("error", expect.stringContaining("ambiguous"))
})
