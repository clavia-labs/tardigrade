import { env } from "cloudflare:workers"
import { test, expect } from "vitest"
import { DEFAULT_R2_OBJECT_PREFIX } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { Schema } from "effect"
import { objectKeyOf, StoredToolResult } from "@clavia/tardigrade-model/object"
import { screenshotBytes, type AgentEnv } from "../fixtures/workerd/agent-fixture.worker"
import { contentScenarios } from "../properties/content/hydration"
import { workerdContentFixture } from "../fixtures/workerd/content-fixture"

for (const scenario of contentScenarios) test(scenario.name, async () => {
  const fixture = await workerdContentFixture()
  try { await scenario.run(fixture) } finally { await fixture.close() }
})

test("tool content persists in R2 before settlement and hydrates on model calls after eviction", async () => {
  const fixture = await workerdContentFixture({ tools: "files" })
  const bucket = (env as unknown as AgentEnv).OBJECTS
  try {
    expect(await fixture.message([{ type: "text", text: "Take two screenshots." }], "screenshots")).toEqual({ status: "completed", output: { text: "ok" } })
    const records = await fixture.records()
    const settledContent = Schema.Struct({ type: Schema.Literal("value"), value: StoredToolResult })
    const results = records.flatMap(record => {
      if (record.event.type !== "EffectSettled" || record.event.outcome.status !== "fulfilled") return []
      const result = record.event.outcome.value
      return Schema.is(settledContent)(result) ? [result.value] : []
    })
    expect(results).toHaveLength(2)
    for (const result of results) expect(result.content.find(part => part.type === "file")).toMatchObject({ byteSize: screenshotBytes.byteLength })
    const returned = records.flatMap(record => record.event.type === "ToolReturned" ? [record.event] : [])
    expect(returned).toHaveLength(2)
    for (const event of returned) {
      expect(event).not.toHaveProperty("output")
      expect(event).toHaveProperty("content")
    }
    const refs = results.flatMap(result => result.content.flatMap(part => part.type === "file" ? [part.object] : []))
    expect(refs).toHaveLength(2)
    expect(refs[0]).toEqual(refs[1])
    for (const ref of refs) {
      const object = await bucket.get(DEFAULT_R2_OBJECT_PREFIX + objectKeyOf(ref))
      if (object === null) throw new Error("Expected tool image in R2")
      expect(new Uint8Array(await object.arrayBuffer())).toEqual(screenshotBytes)
    }
    const log = JSON.stringify(records)
    expect(JSON.stringify(results)).not.toContain('"bytes":')
    expect(log).not.toContain(JSON.stringify(Array.from(screenshotBytes)))
    expect(log).not.toContain(btoa(String.fromCharCode(...screenshotBytes)))

    const assertToolContent = () => {
      const messages = fixture.prompt()?.content ?? []
      const tools = messages.flatMap(message => message.role === "tool" ? message.content : [])
      const contentResult = Schema.Struct({ type: Schema.Literal("content"), value: Schema.Array(Schema.Unknown) })
      const results = tools.flatMap(part => part.type === "tool-result" ? [{ id: part.id, result: Schema.decodeUnknownSync(contentResult)(part.result) }] : [])
      expect(results.map(result => result.id)).toEqual(["capture-1", "capture-2"])
      for (const result of results) {
        expect(result.result.value).toMatchObject([
          { type: "text", text: "Screenshot captured." },
          { type: "file", data: screenshotBytes, mediaType: "image/png", fileName: "screen.png" },
        ])
      }
      expect(messages.some(message => message.role === "user" && message.content.some(part => part.type === "file"))).toBe(false)
    }
    assertToolContent()
    await fixture.restart()
    const calls = fixture.calls()
    expect(await fixture.message([{ type: "text", text: "Inspect those screenshots again." }], "replay-tools")).toEqual({ status: "completed", output: { text: "ok" } })
    expect(fixture.calls()).toBeGreaterThan(calls)
    assertToolContent()
    expect((await fixture.records()).slice(0, records.length)).toEqual(records)
  } finally { await fixture.close() }
})

test("background tool promises persist content before resolution and expose hydrated files", async () => {
  const fixture = await workerdContentFixture({ tools: "background" })
  try {
    expect(await fixture.message([{ type: "text", text: "Capture in the background." }], "background")).toEqual({ status: "completed", output: { text: "ok" } })
    await expect.poll(() => fixture.prompt()?.content.some(message => message.role === "user"
      && message.content.some(part => part.type === "text" && part.text.startsWith("Tool promise result for call"))
      && message.content.some(part => part.type === "file"))).toBe(true)
    const resolved = Schema.Struct({ type: Schema.Literal("PromiseSettled"), result: Schema.Struct({ status: Schema.Literal("fulfilled"), value: StoredToolResult }) })
    const records = await fixture.records()
    const result = records.map(record => record.event).find(Schema.is(resolved))
    if (!result) throw new Error("Expected persisted background tool content")
    const file = result.result.value.content.find(part => part.type === "file")
    if (file?.type !== "file") throw new Error("Expected background image reference")
    expect(file.byteSize).toBe(screenshotBytes.byteLength)
    const object = await (env as unknown as AgentEnv).OBJECTS.get(DEFAULT_R2_OBJECT_PREFIX + objectKeyOf(file.object))
    if (object === null) throw new Error("Expected background image in R2")
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(screenshotBytes)
    expect(JSON.stringify(records)).not.toContain(btoa(String.fromCharCode(...screenshotBytes)))
    const images = fixture.prompt()?.content.flatMap(message => message.role === "user" ? message.content.filter(part => part.type === "file") : [])
    expect(images?.map(image => image.data)).toEqual([screenshotBytes])
  } finally { await fixture.close() }
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
