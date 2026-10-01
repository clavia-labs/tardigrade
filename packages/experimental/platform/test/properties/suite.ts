import * as fc from "fast-check"
import { HOST_PROPERTY_OPTIONS } from "../../../host/properties/config"
import { promiseSettlementOrder } from "../../../host/properties/promise-settlement-order"
import { referenceAcceptanceAtomicity } from "../../../host/properties/reference-acceptance-atomicity"
import { ownedProducerRecovery, externalProducerObservation } from "../../../host/properties/deferred-recovery"

import { cancellationTerminality, cancellationForwarding, cancellationBatchIsolation } from "../../../host/properties/cancellation"

import { turnFactRecovery } from "./turn-facts"
import { toolDeferredLifecycle } from "./tool-deferred-lifecycle"

import { agentTurnCancellation, agentCancellationRecovery, codeModeCancellationRecovery, compactionCancellationRecovery } from "./agent-cancellation"

export const propertyCases = {
  turnFactRecovery: () => fc.assert(turnFactRecovery, HOST_PROPERTY_OPTIONS),
  compactionCancellationRecovery: () => fc.assert(compactionCancellationRecovery, HOST_PROPERTY_OPTIONS),
  agentTurnCancellation: () => fc.assert(agentTurnCancellation, HOST_PROPERTY_OPTIONS),
  agentCancellationRecovery: () => fc.assert(agentCancellationRecovery, HOST_PROPERTY_OPTIONS),
  codeModeCancellationRecovery: () => fc.assert(codeModeCancellationRecovery, HOST_PROPERTY_OPTIONS),
  cancellationBatchIsolation: () => fc.assert(cancellationBatchIsolation, HOST_PROPERTY_OPTIONS),
  cancellationForwarding: () => fc.assert(cancellationForwarding, HOST_PROPERTY_OPTIONS),
  cancellationTerminality: () => fc.assert(cancellationTerminality, HOST_PROPERTY_OPTIONS),
  promiseSettlementOrder: () => fc.assert(promiseSettlementOrder, HOST_PROPERTY_OPTIONS),
  referenceAcceptanceAtomicity: () => fc.assert(referenceAcceptanceAtomicity, HOST_PROPERTY_OPTIONS),
  ownedProducerRecovery: () => fc.assert(ownedProducerRecovery, HOST_PROPERTY_OPTIONS),
  externalProducerObservation: () => fc.assert(externalProducerObservation, HOST_PROPERTY_OPTIONS),
  toolDeferredLifecycle: () => fc.assert(toolDeferredLifecycle, HOST_PROPERTY_OPTIONS),
}
