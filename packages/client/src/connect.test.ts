import { expect, test } from "bun:test"
import { Schema } from "effect"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { connect } from "./connect"
import { ProblemError } from "./problem"

const actor = { name: "tardie", methods: { message: legacyActorMethod({
  input: Schema.String, output: Schema.String,
  event: () => ({ type: "MessageRequested" }), state: () => ({ status: "pending" })
}) } }

test("connect preserves problem details through the configured transport", async () => {
  const client = connect({ url: "https://example.com", actor, token: "secret", fetch: (async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret")
    return Response.json({ type: "https://example.com/not-found", title: "Not Found", status: 404, detail: "Unknown instance" }, { status: 404 })
  }) as typeof fetch })
  const failure = await client.allocateRootThread({ instance: "rick", name: "main" }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(ProblemError)
  expect(failure).toMatchObject({ status: 404, detail: "Unknown instance" })
})

test("connect interrupts an in-flight request with the caller's abort reason", async () => {
  const controller = new AbortController()
  const reason = new Error("caller stopped")
  const client = connect({ url: "https://example.com", actor, fetch: (async (_url, init) => {
    controller.abort(reason)
    return await new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(init.signal.reason)
      else init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    })
  }) as typeof fetch })
  const thread = client.thread({ actor: "tardie", instance: "rick", thread: "main" })
  await expect(thread.methods.message("hello", { key: "request", signal: controller.signal })).rejects.toBe(reason)
})
