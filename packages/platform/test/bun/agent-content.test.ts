import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunFileSystem, BunPath } from "@effect/platform-bun"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel, Prompt, Response } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { modelActs, modelInfo, modelServices } from "@clavia/tardigrade-agent/services/model"
import { toolActs } from "@clavia/tardigrade-agent/services/tools"
import { AskPermission } from "@clavia/tardigrade-agent/contracts/acts"
import { ObjectStorage } from "@clavia/tardigrade-model/object"
import { ModelLock, modelLockOf, modelLockService } from "@clavia/tardigrade-model/lock"
import { BindingSettings, ModelSelection } from "@clavia/tardigrade-model/settings"
import { requestPolicyOf } from "@clavia/tardigrade-model/stream/request"
import { objectStorageFromFileSystem } from "@clavia/tardigrade-bun"
import { createBunHost } from "../../src/bun"

const model = { provider: "fixture", model_id: "test" }
const binding = { provider: "fixture", protocol: "openai-chat-completions", model: "test", endpoint: "https://fixture.invalid", policy: requestPolicyOf({}) }
const lock = modelLockService(modelLockOf({
  schema: 2,
  providers: { fixture: { protocol: "openai-chat-completions", baseUrl: "https://fixture.invalid", env: [] } },
  models: [{ provider: "fixture", model_id: "test", contextWindowTokens: 4096 }],
}), { allow: "*", default: model })

const objectLayer = (directory: string) => objectStorageFromFileSystem(directory).pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)))

test("Bun host replays durable content into the provider as hydrated parts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-"))
  const hostDirectory = join(root, "host")
  const objectDirectory = join(root, "objects")
  let observed: Prompt.Prompt | undefined
  const provider = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: input => Effect.sync(() => {
      observed = Prompt.isPrompt(input.prompt) ? input.prompt : Prompt.fromMessages([])
      return [Response.makePart("text", { text: "ok" })]
    }),
    streamText: input => {
      observed = input.prompt
      return Stream.make(
        Response.makePart("text-start", { id: "reply" }),
        Response.makePart("text-delta", { id: "reply", delta: "ok" }),
        Response.makePart("text-end", { id: "reply" }),
        Response.makePart("finish", { reason: "stop", usage: Response.Usage.make({ inputTokens: {}, outputTokens: {} }) }),
      )
    },
  }))
  const modelLayer = modelServices().pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ModelLock, lock),
    provider,
    Layer.succeed(ModelSelection, { settings: () => Effect.succeed(binding) }),
    Layer.succeed(BindingSettings, binding),
  )))
  const lockLayer = Layer.succeed(ModelLock, lock)
  const agentModelInfo = modelInfo.pipe(Layer.provide(lockLayer))
  const agentModelActs = modelActs.pipe(Layer.provide(modelLayer))
  const objectStorage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objectLayer(objectDirectory))))
  const bytes = new TextEncoder().encode("photo")
  const reference = await Effect.runPromise(objectStorage.put(bytes))
  const services = () => Layer.mergeAll(
    lockLayer,
    agentModelInfo,
    agentModelActs,
    toolActs([]),
    AskPermission.layer(() => Effect.die("No tool permission should be requested")),
    modelLayer,
    objectLayer(objectDirectory),
  )
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: hostDirectory, actorContext, services }))
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
    const reply = await Effect.runPromise(thread.methods.message({ content: [
      { type: "text", text: "Before" },
      { type: "file", mediaType: "image/png", filename: "photo.png", object: reference },
      { type: "text", text: "After" },
    ] }, { id: "message" }))
    expect(reply).toEqual({ text: "ok" })
    const user = observed?.content.find(message => message.role === "user")
    expect(user?.role === "user" ? user.content.map(part => part.type) : []).toEqual(["text", "file", "text"])
    expect(user?.role === "user" && user.content[1]?.type === "file" ? user.content[1] : undefined).toMatchObject({ mediaType: "image/png", fileName: "photo.png", data: bytes })
  } finally {
    await Effect.runPromise(host.close)
    await rm(root, { recursive: true, force: true })
  }
})

test("Bun host fails before provider execution when an object is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "tardie-agent-content-missing-"))
  let providerCalls = 0
  const provider = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: () => Effect.sync(() => { providerCalls++; return [Response.makePart("text", { text: "unexpected" })] }),
    streamText: () => Stream.die("stream is not used"),
  }))
  const modelLayer = modelServices().pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ModelLock, lock), provider,
    Layer.succeed(ModelSelection, { settings: () => Effect.succeed(binding) }),
    Layer.succeed(BindingSettings, binding),
  )))
  const lockLayer = Layer.succeed(ModelLock, lock)
  const services = () => Layer.mergeAll(
    lockLayer,
    modelInfo.pipe(Layer.provide(lockLayer)),
    modelActs.pipe(Layer.provide(modelLayer)),
    toolActs([]),
    AskPermission.layer(() => Effect.die("No tool permission should be requested")),
    modelLayer,
    objectLayer(join(root, "objects")),
  )
  const host = await Effect.runPromise(createBunHost({ actor: createActor, storage: join(root, "host"), actorContext, services }))
  try {
    const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
    const reference = { algorithm: "sha256" as const, digest: "a".repeat(64) }
    await expect(Effect.runPromise(thread.methods.message({ content: [{ type: "file", mediaType: "image/png", object: reference }] }, { id: "missing" }))).rejects.toThrow("Object is missing")
    expect(providerCalls).toBe(0)
  } finally {
    await Effect.runPromise(host.close)
    await rm(root, { recursive: true, force: true })
  }
})
