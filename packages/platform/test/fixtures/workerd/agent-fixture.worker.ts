import { Effect, Layer, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"
import { Rpc } from "effect/unstable/rpc"
import { defineLibrary, ToolResult, MethodExecution } from "@clavia/tardigrade-libraries"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { createActorWorker } from "../../../src/cloudflare"
import { retryServices } from "../retry-provider"
import { contentServices } from "../model-services"

export interface AgentEnv { readonly OBJECTS: R2Bucket }
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
const retry = retryServices()
export const retryCallCount = retry.calls
const worker = createActorWorker({
  actor: createActor,
  actorContext,
  services: (env: AgentEnv, coordinate, _runtime, storage) => coordinate.instance.startsWith("retry-") ? retry.services : Layer.merge(
    contentServicesFor(coordinate.instance),
    objectStorageFromR2(env.OBJECTS, coordinate.instance.startsWith("content-r2-") ? {} : { cache: { storage, bucketNamespace: "agent-content" } }),
  ),
})
export const AgentActorDO = worker.ActorObject
export const AgentThreadDO = worker.ThreadObject
export default worker
