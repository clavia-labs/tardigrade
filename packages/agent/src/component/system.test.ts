import { expect, test } from "bun:test"
import { composeComponents } from "@clavia/tardigrade-core/actor"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import type { Event } from "@clavia/tardigrade-core/event"
import { testMachineOf } from "../../fixtures/component"
import { AGENT_VIEW_ALGEBRA } from "./view"
import { system } from "./system"

test("system contributes static or projected instructions as a component", () => {
  const log: ReadonlyArray<Event> = [{ type: "PackageInstalled", name: "github" }]
  const fixed = system("review the repository")
  const projected = system((events) => `recorded events: ${events.length}`, { name: "system.history" })
  const incremental = system({
    initial: () => 0,
    step: (count, event) => count + (event.type === "PackageInstalled" ? 1 : 0),
    output: (count) => `installed packages: ${count}`
  }, { name: "system.packages" })
  const output = replayProjection(testMachineOf(composeComponents("instructions", AGENT_VIEW_ALGEBRA, [
    fixed,
    projected,
    incremental
  ])), log)

  expect(output.view.system).toEqual(["review the repository", "recorded events: 1", "installed packages: 1"])
})
