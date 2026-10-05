import { Layer } from "effect"
import { Prompt } from "effect/unstable/ai"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import { createActorWorker } from "../../src/cloudflare"
import { retryServices } from "../fixtures/retry-provider"
import { contentServices } from "../fixtures/model-services"

export interface AgentEnv { readonly OBJECTS: R2Bucket }
export let observedPrompt: Prompt.Prompt | undefined
let providerCalls = 0
export const providerCallCount = () => providerCalls
const services = contentServices(prompt => { providerCalls++; observedPrompt = prompt })
const retry = retryServices()
export const retryCallCount = retry.calls
const worker = createActorWorker({
  actor: createActor,
  actorContext,
  services: (env: AgentEnv, coordinate, _runtime, storage) => coordinate.instance.startsWith("retry-") ? retry.services : Layer.merge(
    services,
    objectStorageFromR2(env.OBJECTS, { cache: { storage, bucketNamespace: "agent-content" } }),
  ),
})
export const AgentActorDO = worker.ActorObject
export const AgentThreadDO = worker.ThreadObject
export default worker
