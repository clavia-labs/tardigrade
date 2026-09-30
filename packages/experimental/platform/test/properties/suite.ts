import * as fc from "fast-check"
import { HOST_PROPERTY_OPTIONS } from "../../../host/properties/config"
import { promiseSettlementOrder } from "../../../host/properties/promise-settlement-order"
import { referenceAcceptanceAtomicity } from "../../../host/properties/reference-acceptance-atomicity"
import { ownedProducerRecovery, externalProducerObservation } from "../../../host/properties/deferred-recovery"

import { toolDeferredLifecycle } from "./tool-deferred-lifecycle"

export const propertyCases = {
  promiseSettlementOrder: () => fc.assert(promiseSettlementOrder, HOST_PROPERTY_OPTIONS),
  referenceAcceptanceAtomicity: () => fc.assert(referenceAcceptanceAtomicity, HOST_PROPERTY_OPTIONS),
  ownedProducerRecovery: () => fc.assert(ownedProducerRecovery, HOST_PROPERTY_OPTIONS),
  externalProducerObservation: () => fc.assert(externalProducerObservation, HOST_PROPERTY_OPTIONS),
  toolDeferredLifecycle: () => fc.assert(toolDeferredLifecycle, HOST_PROPERTY_OPTIONS),
}
