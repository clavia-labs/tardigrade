import { deepStrictEqual, strictEqual, ok } from "node:assert"
import type { Prompt } from "effect/unstable/ai"
import type { MethodResult } from "@clavia/tardigrade-core"
import type { MessageContentPart } from "@clavia/tardigrade-agent/contracts/events"
import type { ObjectRef } from "@clavia/tardigrade-model/object"

const assertHydratedContent = (prompt: Prompt.Prompt | undefined, bytes: Uint8Array) => {
  const user = prompt?.content.find(message => message.role === "user")
  if (!user || user.role !== "user") throw new Error("Provider received no user message")
  deepStrictEqual(user.content.map(part => part.type), ["text", "file", "text"])
  const [before, file, after] = user.content
  if (before?.type !== "text" || file?.type !== "file" || after?.type !== "text") throw new Error("Provider received unexpected parts")
  deepStrictEqual([before.text, after.text], ["Before", "After"])
  deepStrictEqual({ mediaType: file.mediaType, filename: file.fileName, bytes: Array.from(file.data as Uint8Array) }, { mediaType: "image/png", filename: "photo.png", bytes: Array.from(bytes) })
}

export interface ContentFixture {
  readonly put: (bytes: Uint8Array) => Promise<ObjectRef>
  readonly message: (content: readonly MessageContentPart[], id: string) => Promise<MethodResult<{ readonly text: string }>>
  readonly prompt: () => Prompt.Prompt | undefined
  readonly calls: () => number
  readonly close: () => Promise<void>
}

export const contentScenarios = [
  { name: "stored file references hydrate in order before provider invocation", run: async (fixture: ContentFixture) => {
    const bytes = new TextEncoder().encode("photo")
    const reference = await fixture.put(bytes)
    deepStrictEqual(await fixture.message([
      { type: "text", text: "Before" },
      { type: "file", mediaType: "image/png", filename: "photo.png", object: reference },
      { type: "text", text: "After" },
    ], "message"), { status: "completed", output: { text: "ok" } })
    assertHydratedContent(fixture.prompt(), bytes)
  } },
  { name: "a missing object fails before provider invocation", run: async (fixture: ContentFixture) => {
    const before = fixture.calls()
    const result = await fixture.message([{ type: "file", mediaType: "image/png", object: { algorithm: "sha256", digest: "a".repeat(64) } }], "missing")
    ok(result.status === "failed" && result.error.includes("Object is missing"))
    strictEqual(fixture.calls(), before)
  } },
] as const
