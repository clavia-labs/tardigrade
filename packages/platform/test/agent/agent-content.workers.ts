import { env, SELF } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { objectRefOf } from "@clavia/tardigrade-model/object"
import type { AgentEnv } from "./fixture.worker"
import { observedPrompt } from "./fixture.worker"

const authorization = { authorization: "Bearer test" }

test("workerd replays durable content into the provider as hydrated parts", async () => {
  const bytes = new TextEncoder().encode("photo")
  const reference = await Effect.runPromise(objectRefOf(bytes))
  const objects = (env as unknown as AgentEnv).OBJECTS
  await objects.put(`objects/${reference.algorithm}:${reference.digest}`, bytes)
  expect((await SELF.fetch("http://test/v1/actors/main/threads", { method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ name: "thread" }) })).status).toBe(200)
  const call = await SELF.fetch("http://test/v1/actors/main/threads/thread/methods/message", { method: "POST", headers: { ...authorization, "content-type": "application/json", "idempotency-key": "message" }, body: JSON.stringify({ content: [
    { type: "text", text: "Before" },
    { type: "file", mediaType: "image/png", filename: "photo.png", object: reference },
    { type: "text", text: "After" },
  ] }) })
  expect(call.status).toBe(202)
  const resultUrl = "http://test/v1/actors/main/threads/thread/methods/message/calls/message"
  await expect.poll(async () => (await SELF.fetch(resultUrl, { headers: authorization })).json()).toMatchObject({ status: "completed", output: { text: "ok" } })
  const user = observedPrompt?.content.find(message => message.role === "user")
  expect(user?.role === "user" ? user.content.map(part => part.type) : []).toEqual(["text", "file", "text"])
  expect(user?.role === "user" && user.content[1]?.type === "file" ? user.content[1] : undefined).toMatchObject({ mediaType: "image/png", fileName: "photo.png", data: bytes })
})
