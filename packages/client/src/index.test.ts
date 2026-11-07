import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { createMethodClient, MethodClientHttpError } from "./index"

const methods = { add: { inputSchema: Schema.Int, outputSchema: Schema.Int } }
const options = { url: "http://test", instance: "main", thread: "one", methods }

test("method clients reject mismatched identities and malformed outputs", async () => {
  for (const body of [
    { id: "different", method: "add", status: "completed", output: 1 },
    { id: "same", method: "different", status: "completed", output: 1 },
    { id: "same", method: "add", status: "completed", output: "wrong" },
    { id: "same", method: "add", status: "unexpected" },
  ]) {
    const client = createMethodClient({ ...options, fetch: async () => Response.json(body) })
    await expect(Effect.runPromise(client.result("add", "same"))).rejects.toThrow()
  }
  const client = createMethodClient({ ...options, fetch: async () => Response.json({ actor: "other", thread: "one", method: "add", id: "same" }, { status: 202 }) })
  await expect(Effect.runPromise(client.invoke("add", 1, { id: "same" }))).rejects.toThrow("different call")
})

test("method clients expose HTTP errors and leave retry decisions with the caller", async () => {
  let requests = 0
  const client = createMethodClient({ ...options, fetch: async () => { requests++; return new Response("conflict", { status: 409 }) } })
  const operations = [Effect.asVoid(client.invoke("add", 1, { id: "same" })), Effect.asVoid(client.result("add", "same")), Effect.asVoid(client.wait("add", "same"))]
  for (const work of operations) {
    const failure = await Effect.runPromise(Effect.flip(work))
    expect(failure).toBeInstanceOf(MethodClientHttpError)
    if (failure instanceof MethodClientHttpError) expect(failure.status).toBe(409)
  }
  expect(requests).toBe(3)
  await expect(Effect.runPromise(client.invoke("add", 1.5, { id: "invalid" }))).rejects.toThrow()
  await expect(Effect.runPromise(client.invoke("add", 1, { id: " " }))).rejects.toThrow()
  await expect(Effect.runPromise(client.invoke("add", 1, { id: " same " }))).rejects.toThrow()
  expect(requests).toBe(3)
})

test("request deadlines abort the local fetch and cover response decoding", async () => {
  let aborted = false
  const client = createMethodClient({ ...options, policy: { requestTimeoutMs: 10 }, fetch: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
  }) })
  await expect(Effect.runPromise(client.result("add", "same"))).rejects.toThrow()
  expect(aborted).toBe(true)
  const stalledBody = createMethodClient({ ...options, policy: { requestTimeoutMs: 10 }, fetch: async () => new Response(new ReadableStream({ start() {} })) })
  await expect(Effect.runPromise(stalledBody.result("add", "same"))).rejects.toThrow()
})
