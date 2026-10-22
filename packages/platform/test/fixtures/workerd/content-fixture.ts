import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { SELF, evictDurableObject } from "cloudflare:test"
import { Effect, Schema } from "effect"
import { methodResult, ThreadCoordinate } from "@clavia/tardigrade-core"
import { ObjectStorage, type InputContentPart, type ContentPart } from "@clavia/tardigrade-model/object"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { cloudflareThreadName } from "../../../src/cloudflare"
import { waitFor } from "../wait"
import type { ContentFixture } from "../../properties/content/hydration"
import { observedPrompt, providerCallCount, type AgentEnv, type AgentThreadDO } from "./agent-fixture.worker"

interface WorkerdContentFixture extends ContentFixture {
  readonly persist: (content: readonly InputContentPart[]) => Promise<readonly ContentPart[]>
  readonly records: () => ReturnType<InstanceType<typeof AgentThreadDO>["records"]>
  readonly restart: () => Promise<void>
}

export async function workerdContentFixture(options: { readonly cache?: boolean; readonly tools?: "files" | "background" } = {}): Promise<WorkerdContentFixture> {
  const prefix = options.tools ? `content-r2-tools${options.tools === "files" ? "" : `-${options.tools}`}` : options.cache === false ? "content-r2" : "content"
  const instance = `${prefix}-${crypto.randomUUID()}`
  const base = `http://test/v1/actors/${instance}/threads`
  const created = await SELF.fetch(base, { method: "POST", body: JSON.stringify({ name: "thread" }) })
  assert.equal(created.status, 200)
  const coordinate = Schema.decodeUnknownSync(ThreadCoordinate)(await created.json())
  const threads = (env as unknown as { THREADS: DurableObjectNamespace<InstanceType<typeof AgentThreadDO>> }).THREADS
  const stub = threads.getByName(cloudflareThreadName(coordinate))
  const objects = objectStorageFromR2((env as unknown as AgentEnv).OBJECTS)
  const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objects)))
  const resultSchema = Schema.Union([methodResult(Schema.Struct({ text: Schema.String })), Schema.Struct({ status: Schema.Literal("pending") })])
  return {
    put: bytes => Effect.runPromise(storage.put(bytes)),
    persist: content => Effect.runPromise(ObjectStorage.persist(content).pipe(Effect.provideService(ObjectStorage, storage))),
    records: () => stub.records(),
    restart: async () => { await stub.dispose(); await evictDurableObject(stub) },
    message: async (content, id) => {
      const method = `${base}/thread/methods/message`
      const accepted = await SELF.fetch(method, { method: "POST", headers: { "idempotency-key": id }, body: JSON.stringify({ content }) })
      assert.equal(accepted.status, 202)
      await accepted.arrayBuffer()
      const result = await waitFor(async () => Schema.decodeUnknownSync(resultSchema)(await (await SELF.fetch(`${method}/calls/${id}`)).json()), value => value.status !== "pending")
      if (result.status === "pending") throw new Error("Content call did not settle")
      return result
    },
    prompt: () => observedPrompt,
    calls: providerCallCount,
    close: () => stub.dispose(),
  }
}
