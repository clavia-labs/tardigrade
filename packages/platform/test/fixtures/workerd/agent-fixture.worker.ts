import { Effect, Layer, Schema } from "effect"
import { Prompt, type LanguageModel } from "effect/ai"
import { Rpc } from "effect/rpc"
import { Library, ToolResult, MethodExecution, MethodHints } from "@clavia/tardigrade-libraries"
import { agent } from "@clavia/tardigrade-agent"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { Bindings, DurableStorage, HostThread, host } from "../../../src/cloudflare"
import { retryServices } from "../retry-provider"
import { contentModelServices } from "../agent"

export interface AgentEnv { readonly OBJECTS: R2Bucket }
export let observedPrompt: Prompt.Prompt | undefined
export let observedTools: LanguageModel.ProviderOptions["tools"] = []
let providerCalls = 0
export const providerCallCount = () => providerCalls
const services = contentModelServices(prompt => { providerCalls++; observedPrompt = prompt })
export const screenshotBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII="), character => character.charCodeAt(0))
const CaptureInput = Schema.Struct({ screen: Schema.String })

let captures = 0
export const screenCaptureCount = () => captures
const capture = (_input: typeof CaptureInput.Type) => Effect.sync(() => {
  captures++
  return { content: [
    { type: "text" as const, text: "Screenshot captured." },
    { type: "file" as const, mediaType: "image/png", filename: "screen.png", bytes: screenshotBytes },
  ] }
})
const screenshots = Library.make("screen",
  Rpc.make("capture", { payload: CaptureInput, success: ToolResult, error: Schema.String }).annotate(MethodHints, { readOnlyHint: true }),
  Rpc.make("captureBackground", { payload: CaptureInput, success: ToolResult, error: Schema.String }).annotate(MethodExecution, "background"),
)
const screenLayer = Layer.succeed(screenshots, { capture, captureBackground: capture })
const assistant = agent({ name: "tardie", system: "You are a friendly assistant.", tools: [screenshots] })
const toolContent = contentModelServices(prompt => { providerCalls++; observedPrompt = prompt }, {
  observeTools: tools => { observedTools = tools },
  toolCalls: [{ id: "capture-1", name: "screen__capture", params: { screen: "main" } }, { id: "capture-2", name: "screen__capture", params: { screen: "main" } }],
})
const backgroundToolContent = contentModelServices(prompt => { providerCalls++; observedPrompt = prompt }, {
  toolCalls: [{ id: "capture-background", name: "screen__captureBackground", params: { screen: "main" } }],
})
const contentServicesFor = (instance: string) => {
  if (instance.startsWith("content-r2-tools-background-")) return backgroundToolContent
  if (instance.startsWith("content-r2-tools-")) return toolContent
  return services
}
const retry = retryServices()
export const retryCallCount = retry.calls
const appLayer = Layer.unwrap(Effect.gen(function* () {
  const env = yield* Bindings<AgentEnv>()
  const coordinate = yield* HostThread
  const storage = yield* DurableStorage
  return Layer.mergeAll(
    coordinate.instance.startsWith("retry-") ? retry.services : contentServicesFor(coordinate.instance),
    screenLayer,
    objectStorageFromR2(env.OBJECTS, coordinate.instance.startsWith("content-r2-") ? {} : { cache: { storage, bucketNamespace: "agent-content" } }),
  )
}))
const worker = host(assistant, { layer: appLayer })
export const AgentActorDO = worker.ActorObject
export const AgentThreadDO = worker.ThreadObject
export default worker
