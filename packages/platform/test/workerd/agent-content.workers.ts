import { env } from "cloudflare:workers"
import { test, expect } from "vitest"
import { DEFAULT_R2_OBJECT_PREFIX } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { objectKeyOf } from "@clavia/tardigrade-model/object"
import { type AgentEnv } from "../fixtures/workerd/agent-fixture.worker"
import { contentScenarios } from "../properties/content/hydration"
import { workerdContentFixture } from "../fixtures/workerd/content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await workerdContentFixture()
  try { await scenario.run(fixture) } finally { await fixture.close() }
})

test("R2 content persists as refs in the journal and hydrates after thread eviction", async () => {
  const fixture = await workerdContentFixture({ cache: false })
  const bucket = (env as unknown as AgentEnv).OBJECTS
  const bytes = new TextEncoder().encode(`image-${crypto.randomUUID()}`)
  try {
    const content = await fixture.persist([
      { type: "text", text: "Before" },
      { type: "file", mediaType: "image/png", filename: "photo.png", byteSize: 0, bytes },
      { type: "text", text: "After" },
    ])
    const file = content[1]
    if (file?.type !== "file") throw new Error("Expected persisted file reference")
    expect(file).toEqual({ type: "file", mediaType: "image/png", filename: "photo.png", byteSize: bytes.byteLength, object: file.object })
    expect(await fixture.persist([file])).toEqual([file])
    const { byteSize: _byteSize, ...legacyFile } = file
    expect(await fixture.persist([legacyFile])).toEqual([legacyFile])
    const key = DEFAULT_R2_OBJECT_PREFIX + objectKeyOf(file.object)
    const stored = await bucket.get(key)
    if (stored === null) throw new Error("Expected persisted R2 object")
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes)
    expect(await fixture.message(content, "image")).toEqual({ status: "completed", output: { text: "ok" } })

    const records = await fixture.records()
    const turn = records.find(record => record.message?.id === "image")
    expect(turn?.message?.invocation).toMatchObject({ method: "message", input: { content } })
    expect(JSON.stringify(records)).not.toContain(new TextDecoder().decode(bytes))
    expect(JSON.stringify(records)).not.toContain(JSON.stringify(Array.from(bytes)))
    expect(JSON.stringify(records)).not.toContain('"bytes":')
    const assertImage = () => {
      const user = fixture.prompt()?.content.find(message => message.role === "user")
      if (user?.role !== "user") throw new Error("Expected user content in model prompt")
      expect(user.content.map(part => part.type)).toEqual(["text", "file", "text"])
      expect(user.content[0]).toMatchObject({ type: "text", text: "Before" })
      expect(user.content[2]).toMatchObject({ type: "text", text: "After" })
      const image = user.content[1]
      if (image?.type !== "file") throw new Error("Expected hydrated image in model prompt")
      expect(image.mediaType).toBe("image/png")
      expect(image.fileName).toBe("photo.png")
      expect(image.data).toEqual(bytes)
    }
    assertImage()

    await fixture.restart()
    const before = fixture.calls()
    expect(await fixture.message([{ type: "text", text: "Inspect the previous image again." }], "replay")).toEqual({ status: "completed", output: { text: "ok" } })
    expect(fixture.calls()).toBeGreaterThan(before)
    assertImage()
    expect((await fixture.records()).slice(0, records.length)).toEqual(records)

    await bucket.delete(key)
    const calls = fixture.calls()
    expect(await fixture.message([{ type: "text", text: "Inspect again." }], "missing")).toMatchObject({ status: "failed", error: expect.stringContaining("Object is missing") })
    expect(fixture.calls()).toBe(calls)
  } finally { await fixture.close() }
})
