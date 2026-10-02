import { describe, expect, test } from "bun:test"
import type { AgentView } from "./view"
import { AGENT_VIEW_ALGEBRA } from "./view"

const viewOf = (name: string): AgentView => ({
  system: [name],
  tools: [{ spec: { name, description: name, inputSchema: {} } }],
  context: [{ component: name, policy: {} }],
  output: [{ component: name, kind: "native" }]
})

describe("agent view algebra laws", () => {
  test("empty is an identity and combine is associative", () => {
    const [left, middle, right] = [viewOf("left"), viewOf("middle"), viewOf("right")]
    expect(AGENT_VIEW_ALGEBRA.combine(AGENT_VIEW_ALGEBRA.empty, left)).toEqual(left)
    expect(AGENT_VIEW_ALGEBRA.combine(left, AGENT_VIEW_ALGEBRA.empty)).toEqual(left)
    expect(AGENT_VIEW_ALGEBRA.combine(AGENT_VIEW_ALGEBRA.combine(left, middle), right)).toEqual(
      AGENT_VIEW_ALGEBRA.combine(left, AGENT_VIEW_ALGEBRA.combine(middle, right))
    )
  })
})
