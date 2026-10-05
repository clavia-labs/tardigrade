import { deepStrictEqual } from "node:assert"
import type { Prompt } from "effect/unstable/ai"

export const assertHydratedContent = (prompt: Prompt.Prompt | undefined, bytes: Uint8Array) => {
  const user = prompt?.content.find(message => message.role === "user")
  if (!user || user.role !== "user") throw new Error("Provider received no user message")
  deepStrictEqual(user.content.map(part => part.type), ["text", "file", "text"])
  const [before, file, after] = user.content
  if (before?.type !== "text" || file?.type !== "file" || after?.type !== "text") throw new Error("Provider received unexpected parts")
  deepStrictEqual([before.text, after.text], ["Before", "After"])
  deepStrictEqual({ mediaType: file.mediaType, filename: file.fileName, bytes: Array.from(file.data as Uint8Array) }, { mediaType: "image/png", filename: "photo.png", bytes: Array.from(bytes) })
}
