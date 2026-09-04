import definition from "./actor"
import { ActorDO, ThreadDO, cloudflareWorker, modelScopeFrom } from "tardie/cloudflare"
import { modelAdapters } from "tardie/model/adapter"
import { openAICompatibleAdapter } from "tardie/model/openai"
import modelLock from "./models.lock.json"

export { ActorDO, ThreadDO }
export default cloudflareWorker(definition, {
  modelAdapters: modelAdapters(openAICompatibleAdapter),
  modelScope: modelScopeFrom(modelLock)
})
