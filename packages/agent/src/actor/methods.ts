import { actorMethodsOf } from "@clavia/tardigrade-core/method"
import { requestBudgetMethod } from "./budget"
import { agentMessageMethod } from "./message"

export const agentMethods = actorMethodsOf({
  message: agentMessageMethod,
  requestBudget: requestBudgetMethod
})
