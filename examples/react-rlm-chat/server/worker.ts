import definition from "./actor"
import { defineWorkerHost, workerHttp, workerModelServices, modelScopeFrom } from "tardie/worker"
import { modelAdapters } from "tardie/model/adapter"
import { openAICompatibleAdapter } from "tardie/model/openai"
import modelLock from "./models.lock.json"

const services = workerModelServices({
  adapters: modelAdapters(openAICompatibleAdapter),
  scope: modelScopeFrom(modelLock)
})

const host = defineWorkerHost(definition, { services })
const http = workerHttp(host)

// host exposes the HTTP handler and Durable Object classes (platform/cloudflare/test/actor.workers.ts).
// HTTP request -> Worker handler
//                  +-- ActorDO: allocates and tracks threads
//                  +-- ThreadDO: stores events and executes a thread
export const { ActorDO, ThreadDO } = host

export default {
  fetch: http.fetch
}
