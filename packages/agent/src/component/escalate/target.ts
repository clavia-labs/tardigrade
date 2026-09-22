import type { ActorMethods, CallerRef, ThreadTarget } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { isThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import { requestBudgetMethod } from "../../actor/budget"
import { requestPermissionMethod } from "../../actor/permission"

export type AuthorityTarget<Methods extends ActorMethods> = ThreadTarget<Methods> | CallerRef<Methods>

// caller selects the actor that sent the request being considered.
export const caller = () => ({
  kind: "caller" as const,
  methods: { requestBudget: requestBudgetMethod, requestPermission: requestPermissionMethod }
})

// authorityTarget resolves a caller reference from the accepted request's source.
export const authorityTarget = <Methods extends ActorMethods>(
  authority: AuthorityTarget<Methods>,
  received: Event | undefined
): ThreadTarget<Methods> | undefined => {
  if ("coordinate" in authority || "address" in authority) return authority
  const source = (received as { readonly link?: { readonly source?: unknown } } | undefined)?.link?.source
  return isThreadAddress(source) ? { coordinate: source, methods: authority.methods } : undefined
}
