import { DurableObject } from "cloudflare:workers"
import { FetchHttpClient } from "effect/unstable/http"
import { providerLayer } from "@clavia/tardigrade-model/providers/openai-compat"
import { modelService, type ModelReply } from "../model-service"
import { Effect, Layer, Redacted, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Rpc } from "effect/unstable/rpc"
import { defineLibrary, ToolResult, MethodExecution } from "@clavia/tardigrade-libraries"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { createActorWorker } from "../../../src/cloudflare"
import { retryServices } from "../retry-provider"
import { contentServices } from "../agent"

export class ModelServerDO extends DurableObject {
  private readonly model = modelService()
  async enqueue(script: readonly ModelReply[]) { this.model.enqueue(...script) }
  async inspect() { return this.model.inspect() }
  override fetch(request: Request) { return this.model.fetch(request) }
}
export interface AgentEnv { readonly OBJECTS: R2Bucket; readonly MODELS: DurableObjectNamespace<ModelServerDO> }
export let observedPrompt: Prompt.Prompt | undefined
let providerCalls = 0
export const providerCallCount = () => providerCalls
const services = contentServices(prompt => { providerCalls++; observedPrompt = prompt })
export const screenshotBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII="), character => character.charCodeAt(0))
const capture = () => Effect.succeed({ content: [
  { type: "text" as const, text: "Screenshot captured." },
  { type: "file" as const, mediaType: "image/png", filename: "screen.png", bytes: screenshotBytes },
] })
const screenshots = defineLibrary({
  name: "screen", description: "Capture the screen.",
  methods: [
    Rpc.make("capture", { payload: Schema.Struct({ screen: Schema.String }), success: ToolResult, error: Schema.String }),
    Rpc.make("captureBackground", { payload: Schema.Struct({ screen: Schema.String }), success: ToolResult, error: Schema.String }).annotate(MethodExecution, "background"),
  ],
}).implement({ capture, captureBackground: capture })
const toolContent = contentServices(prompt => { providerCalls++; observedPrompt = prompt }, {
  libraries: [screenshots],
  toolCalls: [{ id: "capture-1", name: "screen__capture", params: { screen: "main" } }, { id: "capture-2", name: "screen__capture", params: { screen: "main" } }],
})
const backgroundToolContent = contentServices(prompt => { providerCalls++; observedPrompt = prompt }, {
  libraries: [screenshots], toolCalls: [{ id: "capture-background", name: "screen__captureBackground", params: { screen: "main" } }],
})
const contentServicesFor = (instance: string) => {
  if (instance.startsWith("content-r2-tools-background-")) return backgroundToolContent
  if (instance.startsWith("content-r2-tools-")) return toolContent
  return services
}
const httpServices = (env: AgentEnv, instance: string) => {
  const server = env.MODELS.getByName(instance)
  const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => server.fetch(typeof input === "string" || input instanceof URL ? new Request(input.toString(), init) : new Request(input, init)), { preconnect: globalThis.fetch.preconnect })
  const provider = providerLayer({ provider: "openai-compat", client: { apiKey: Redacted.make("fixture"), apiUrl: "https://model.fixture/v1" }, model: { model: "test" } }).pipe(Layer.provide(FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))))
  return contentServices(prompt => { providerCalls++; observedPrompt = prompt }, { provider, libraries: [screenshots], request: { retry: { backoffMs: [0], retryAfterJitterMs: 0 } } })
}
const retry = retryServices()
export const retryCallCount = retry.calls
const worker = createActorWorker({
  actor: createActor,
  actorContext,
  checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } },
  checkpointTree: { collectEvery: 1 },
  services: (env: AgentEnv, coordinate, _runtime, storage) => coordinate.instance.startsWith("retry-") ? retry.services : Layer.merge(
    coordinate.instance.startsWith("http-model-") ? httpServices(env, coordinate.instance) : contentServicesFor(coordinate.instance),
    objectStorageFromR2(env.OBJECTS, coordinate.instance.startsWith("content-r2-") ? {} : { cache: { storage, bucketNamespace: "agent-content" } }),
  ),
})
export const AgentActorDO = worker.ActorObject
export const AgentThreadDO = worker.ThreadObject
export default worker
