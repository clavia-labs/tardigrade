import type { Event } from "@clavia/tardigrade-core/event"
import { methodIngressKeyOf } from "@clavia/tardigrade-core/interaction/invocation"
import { threadKeys } from "@clavia/tardigrade-core/interaction/relations"

// hostEventKeyOf combines framework and application event identities (event-key.test.ts).
export const hostEventKeyOf = (event: Event, applicationKeyOf?: (event: Event) => string | undefined): string | undefined =>
  methodIngressKeyOf(event) ?? threadKeys.keyOf(event) ?? applicationKeyOf?.(event)

// requireDeliveryKey rejects unkeyed delivery when the host enforces application keys (event-key.test.ts).
export const requireDeliveryKey = (event: Event, address: string, applicationKeyOf?: (event: Event) => string | undefined): void => {
  if (applicationKeyOf !== undefined && hostEventKeyOf(event, applicationKeyOf) === undefined && event.type !== "MessageReceived") {
    throw new Error(`unkeyed cross-thread event "${event.type}" to ${address}: every delivered event names its occurrence in its package's key fragment`)
  }
}
