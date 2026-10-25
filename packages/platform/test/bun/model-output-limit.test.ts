import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { createBunHost } from "../../src/bun"

for (const enabled of [false, true]) test(`output-limit continuation is opt-in: ${enabled}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-output-limit-"))
  const model = { provider: "fixture", model_id: "test" }
  const lock = modelLockService(modelLockOf({ schema: 2,
    providers: { fixture: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: [] } },
    models: [{ ...model, contextWindowTokens: 4096 }],
  }), { allow: "*", default: model })
  const settings = { provider: "fixture", protocol: "openai-chat-completions" as const, model: "test", endpoint: "https://fixture.invalid", policy: requestPolicyOf({ maxOutputTokens: 8 }) }
  let calls = 0
  const provider = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: () => Effect.die("Only native streaming inference is used"),
    streamText: () => Stream.suspend(() => {
      const limited = calls++ === 0
      return Stream.make(
        Response.makePart("text-start", { id: "text" }),
        Response.makePart("text-delta", { id: "text", delta: limited ? "Unfinished work" : "Completed work" }),
        Response.makePart("text-end", { id: "text" }),
        Response.makePart("finish", { reason: limited ? "length" : "stop", usage: Response.Usage.make({ inputTokens: { total: 1 }, outputTokens: { total: limited ? 8 : 2 } }) }),
      )
    }),
  }))
  const modelLayer = modelServices({ continueOnOutputLimit: enabled }).pipe(Layer.provide(Layer.mergeAll(
    provider, Layer.succeed(ModelLock, lock), Layer.succeed(ModelSelection, { settings: () => Effect.succeed(settings) }), Layer.succeed(BindingSettings, settings),
  )))
  const services = Layer.mergeAll(modelInfo.pipe(Layer.provide(Layer.succeed(ModelLock, lock))), modelActs.pipe(Layer.provide(modelLayer)), toolActs([]), AskPermission.layer(() => Effect.die("No tools")))
  const open = () => Effect.runPromise(createBunHost({ actor: createActor, actorContext, storage: root, services: () => services }))
  let host = await open()
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "author" }))
    await Effect.runPromise(thread.invoke("message", { text: "Complete the work" }, { id: "turn" }))
    await Effect.runPromise(thread.wait)
    const result = await Effect.runPromise(thread.result("message", "turn"))
    expect(result).toMatchObject(enabled ? { status: "completed", output: { text: "Completed work" } } : { status: "failed" })
    const records = await Effect.runPromise(thread.records())
    const replies = records.filter(row => row.event.type === "ModelReturned" && row.event.purpose === "inference")
    expect(replies).toHaveLength(enabled ? 2 : 0)
    if (enabled) expect(replies[0]!.event).toMatchObject({ outputLimit: 8, toolCalls: [], usage: { output: 8 } })
    expect(calls).toBe(enabled ? 2 : 1)
    await Effect.runPromise(host.close)
    host = await open()
    const restored = await Effect.runPromise(host.getThread(thread.coordinate))
    expect(restored).toBeDefined()
    expect(await Effect.runPromise(restored!.result("message", "turn"))).toEqual(result)
    expect(await Effect.runPromise(restored!.records())).toEqual(records)
    expect(calls).toBe(enabled ? 2 : 1)
  } finally { await Effect.runPromise(host.close); await rm(root, { recursive: true, force: true }) }
})
