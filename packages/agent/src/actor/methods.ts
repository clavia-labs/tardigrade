import { actorMethodsOf } from "@clavia/tardigrade-core/actor/method"
import { requestBudgetMethod } from "./budget"
import { agentMessageMethod } from "./message"

export const agentMethods = actorMethodsOf({
  message: agentMessageMethod,
  requestBudget: requestBudgetMethod
})
