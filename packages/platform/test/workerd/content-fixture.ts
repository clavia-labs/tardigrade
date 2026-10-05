import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF } from "cloudflare:test"
import { Effect, Schema } from "effect"
import { methodResult, ThreadCoordinate } from "@clavia/tardigrade-core"
import { objectRefOf, objectKeyOf } from "@clavia/tardigrade-model/object"
import { cloudflareThreadName } from "../../src/cloudflare"
import { waitFor } from "../fixtures/wait"
import type { ContentFixture } from "../properties/content/hydration"
import { observedPrompt, providerCallCount, type AgentEnv, type AgentThreadDO } from "./agent-fixture.worker"

export async function workerdContentFixture(): Promise<ContentFixture> {
  const base = `http://test/v1/actors/content-${crypto.randomUUID()}/threads`
  const created = await SELF.fetch(base, { method: "POST", body: JSON.stringify({ name: "thread" }) })
  assert.equal(created.status, 200)
  const coordinate = Schema.decodeUnknownSync(ThreadCoordinate)(await created.json())
  const threads = (env as unknown as { THREADS: DurableObjectNamespace<InstanceType<typeof AgentThreadDO>> }).THREADS
  const resultSchema = Schema.Union([methodResult(Schema.Struct({ text: Schema.String })), Schema.Struct({ status: Schema.Literal("pending") })])
  return {
    put: async bytes => {
      const reference = await Effect.runPromise(objectRefOf(bytes))
      await (env as unknown as AgentEnv).OBJECTS.put(`objects/${objectKeyOf(reference)}`, bytes)
      return reference
    },
    message: async (content, id) => {
      const method = `${base}/thread/methods/message`
      assert.equal((await SELF.fetch(method, { method: "POST", headers: { "idempotency-key": id }, body: JSON.stringify({ content }) })).status, 202)
      const result = await waitFor(async () => Schema.decodeUnknownSync(resultSchema)(await (await SELF.fetch(`${method}/calls/${id}`)).json()), value => value.status !== "pending")
      if (result.status === "pending") throw new Error("Content call did not settle")
      return result
    },
    prompt: () => observedPrompt,
    calls: providerCallCount,
    close: () => threads.getByName(cloudflareThreadName(coordinate)).dispose(),
  }
}
