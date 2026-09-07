import definition from "./actor"
import { createWorker, modelScopeFrom } from "tardie/worker"
import { modelAdapters } from "tardie/model/adapter"
import { openAICompatibleAdapter } from "tardie/model/openai"
import modelLock from "./models.lock.json"

const { worker, ActorDO, ThreadDO } = createWorker(definition, {
  modelAdapters: modelAdapters(openAICompatibleAdapter),
  modelScope: modelScopeFrom(modelLock)
})

export { ActorDO, ThreadDO }
export default worker
