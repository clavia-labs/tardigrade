import { expect, test } from "bun:test"
import { contentScenarios } from "../properties/content/hydration"
import { bunContentFixture } from "../fixtures/bun/content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await bunContentFixture()
  try {
    await scenario.run(fixture)
    if (scenario === contentScenarios[0]) {
      await fixture.reopen()
      expect(await fixture.message([{ type: "text", text: "Again" }], "again")).toEqual({ status: "completed", output: { text: "ok" } })
      const users = fixture.prompt()?.content.filter(message => message.role === "user")
      expect(users?.map(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []))).toEqual([["Before", "After"], ["Again"]])
      const file = users?.[0]?.content.find(part => part.type === "file")
      expect(file?.type === "file" && file.data).toEqual(new TextEncoder().encode("photo"))
    }
  } finally { await fixture.close() }
})
