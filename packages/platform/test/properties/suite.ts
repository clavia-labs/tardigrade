import { stateValidation } from "./runtime/state-validation"
import { snapshotLookups } from "./runtime/snapshot-lookups"
import { checkpointChunks } from "./runtime/checkpoint-chunks"
import { atomCheckpoint } from "./runtime/atom-checkpoint"
import { referenceCoordinates } from "./runtime/reference-coordinates"
import { inputCanonicalization, inputRepresentation } from "./runtime/input-representation"
import { promiseDeadline } from "./runtime/promise-deadline"
import * as fc from "fast-check"
import { RUNTIME_PROPERTY_OPTIONS } from "./runtime/config"
import { promiseSettlementOrder } from "./runtime/promise-settlement-order"
import { referenceAcceptanceAtomicity } from "./runtime/reference-acceptance-atomicity"
import { ownedProducerRecovery, externalProducerObservation } from "./runtime/deferred-recovery"
import { settledEffect, settledEffectExamples } from "./runtime/settled-effect"

import { cancellationTerminality, cancellationForwarding, cancellationBatchIsolation } from "./runtime/cancellation"

import { turnFactRecovery } from "./turn-facts"
import { toolDeferredLifecycle } from "./tool-deferred-lifecycle"

import { agentTurnCancellation, agentCancellationRecovery, codeModeCancellationRecovery, compactionCancellationRecovery } from "./agent-cancellation"

export const propertyCases = {
  stateValidation,
  snapshotLookups: () => fc.assert(snapshotLookups, RUNTIME_PROPERTY_OPTIONS),
  checkpointChunks: () => fc.assert(checkpointChunks, RUNTIME_PROPERTY_OPTIONS),
  atomCheckpoint: () => fc.assert(atomCheckpoint, RUNTIME_PROPERTY_OPTIONS),
  referenceCoordinates: () => fc.assert(referenceCoordinates, RUNTIME_PROPERTY_OPTIONS),
  inputCanonicalization,
  inputRepresentation: () => fc.assert(inputRepresentation, RUNTIME_PROPERTY_OPTIONS),
  promiseDeadline,
  turnFactRecovery: () => fc.assert(turnFactRecovery, RUNTIME_PROPERTY_OPTIONS),
  compactionCancellationRecovery: () => fc.assert(compactionCancellationRecovery, RUNTIME_PROPERTY_OPTIONS),
  agentTurnCancellation: () => fc.assert(agentTurnCancellation, RUNTIME_PROPERTY_OPTIONS),
  agentCancellationRecovery: () => fc.assert(agentCancellationRecovery, RUNTIME_PROPERTY_OPTIONS),
  codeModeCancellationRecovery: () => fc.assert(codeModeCancellationRecovery, RUNTIME_PROPERTY_OPTIONS),
  cancellationBatchIsolation: () => fc.assert(cancellationBatchIsolation, RUNTIME_PROPERTY_OPTIONS),
  cancellationForwarding: () => fc.assert(cancellationForwarding, RUNTIME_PROPERTY_OPTIONS),
  cancellationTerminality: () => fc.assert(cancellationTerminality, RUNTIME_PROPERTY_OPTIONS),
  promiseSettlementOrder: () => fc.assert(promiseSettlementOrder, RUNTIME_PROPERTY_OPTIONS),
  referenceAcceptanceAtomicity: () => fc.assert(referenceAcceptanceAtomicity, RUNTIME_PROPERTY_OPTIONS),
  ownedProducerRecovery: () => fc.assert(ownedProducerRecovery, RUNTIME_PROPERTY_OPTIONS),
  externalProducerObservation: () => fc.assert(externalProducerObservation, RUNTIME_PROPERTY_OPTIONS),
  settledEffect: () => fc.assert(settledEffect, { ...RUNTIME_PROPERTY_OPTIONS, examples: settledEffectExamples }),
  toolDeferredLifecycle: () => fc.assert(toolDeferredLifecycle, RUNTIME_PROPERTY_OPTIONS),
}
