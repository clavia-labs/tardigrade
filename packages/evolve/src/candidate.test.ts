import { describe, expect, test } from "bun:test"
import { createAgent, inference } from "@flamecast/harness"
import { candidate } from "./candidate"

describe("a code candidate", () => {
  const parent = createAgent({ id: "git:base", modules: [inference()] })
  const child = createAgent({
    id: "git:terse",
    parent: parent.program.id,
    modules: [inference({ system: "Answer in one sentence." })]
  })
  const wrapped = candidate(child.program.id, child, {
    parent: parent.program.id,
    source: "src/candidates/terse.ts"
  })

  test("holds the constructed program rather than a prescribed patch", () => {
    expect(wrapped.value).toBe(child)
    expect(wrapped.id).toBe("git:terse")
    expect(wrapped.parent).toBe("git:base")
    expect(wrapped.source).toBe("src/candidates/terse.ts")
  })

  test("does not mutate its parent", () => {
    expect(parent.request([]).system).not.toBe("Answer in one sentence.")
    expect(parent.program.parent).toBeUndefined()
  })

  test("wraps values from any search algorithm", () => {
    const loraPopulation = candidate("population:17", {
      adapters: ["reasoner-a", "reasoner-b"],
      generation: 4
    })
    expect(loraPopulation.value.generation).toBe(4)
  })
})
