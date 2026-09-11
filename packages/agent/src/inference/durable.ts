import { Clock, Data, Effect, Random } from "effect"
import type { Context } from "effect"
import { EventLog } from "@clavia/tardigrade-core/log"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { Action } from "../log/events"
import type { InferRequest } from "./contract"

export interface InferenceAmbiguityPolicy { readonly decision: "stop" | "retry" }
export const DEFAULT_INFERENCE_AMBIGUITY_POLICY: InferenceAmbiguityPolicy = { decision: "stop" }

export class InferenceReceiptError extends Data.TaggedError("InferenceReceiptError")<{ readonly message: string }> {}

export interface InferenceAttemptPosition { readonly attempt: number; readonly rung: number; readonly retry: number }
export interface PreparedInference { readonly fingerprint: string; readonly route: unknown }
export type InferenceAttemptDecision =
  | { readonly outcome: "retryable" | "truncated"; readonly next: InferenceAttemptPosition; readonly error: string; readonly evidence?: unknown }
  | { readonly outcome: "unknown"; readonly decision: "stop" | "retry"; readonly next?: InferenceAttemptPosition; readonly error: string; readonly evidence?: unknown }

type Requested = { readonly type: "InferenceRequested"; readonly requestId: string; readonly callId: string; readonly token: string; readonly fingerprint: string; readonly route: unknown; readonly policy: InferenceAmbiguityPolicy; readonly position: InferenceAttemptPosition; readonly turn: string; readonly at: number }
type Decided = { readonly type: "InferenceAttemptDecided"; readonly requestId: string; readonly fingerprint: string; readonly position: InferenceAttemptPosition; readonly decision: InferenceAttemptDecision; readonly turn: string; readonly at: number }
type Retained = { readonly type: "InferenceResultRetained"; readonly requestId: string; readonly fingerprint: string; readonly action: Action; readonly turn: string; readonly at: number }

export type InferenceAttemptState =
  | { readonly status: "retained"; readonly action: Action; readonly fingerprint: string }
  | { readonly status: "decided"; readonly decision: InferenceAttemptDecision }
  | { readonly status: "pending" }
  | { readonly status: "inFlight" }
  | { readonly status: "begun" }

const canonicalValue = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("durable inference metadata contains a non-finite number")
    return value
  }
  if (typeof value !== "object") throw new Error(`durable inference metadata contains unsupported ${typeof value}`)
  if (ancestors.has(value)) throw new Error("durable inference metadata contains a cycle")
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error("durable inference metadata contains a sparse array")
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("durable inference metadata contains a non-plain object")
  ancestors.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => canonicalValue(item, ancestors))
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalValue(item, ancestors)]))
  ancestors.delete(value)
  return result
}

export const canonicalInferenceJson = (value: unknown): string => {
  const json = JSON.stringify(canonicalValue(value))
  if (json === undefined) throw new Error("durable inference metadata must be finite JSON")
  return json
}

const finiteJson = <A>(value: A): A => JSON.parse(canonicalInferenceJson(value)) as A

export const inferenceRequestIdentity = (scope: string, request: InferRequest, callId: string): string => {
  if (scope.length === 0) throw new Error("durable inference scope must not be empty")
  const { actor, instance, thread, turn } = request.identity
  return canonicalInferenceJson([scope, actor, instance, thread, turn, callId])
}

export const inferenceProviderKey = (requestId: string): Effect.Effect<string> => Effect.promise(async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(requestId))
  const binary = String.fromCharCode(...new Uint8Array(digest))
  return `tdg_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`
})

export const inferenceFingerprint = (value: unknown): Effect.Effect<string> => Effect.promise(async () => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalInferenceJson(value)))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
})

const samePosition = (a: InferenceAttemptPosition, b: InferenceAttemptPosition): boolean => a.attempt === b.attempt && a.rung === b.rung && a.retry === b.retry
const rows = (events: ReadonlyArray<Event>, requestId: string) => {
  const matching = events.filter((event) => (event as { readonly requestId?: unknown }).requestId === requestId)
  return {
    requests: matching.filter((event): event is Event & Requested => event.type === "InferenceRequested"),
    decisions: matching.filter((event): event is Event & Decided => event.type === "InferenceAttemptDecided"),
    retained: matching.find((event): event is Event & Retained => event.type === "InferenceResultRetained")
  }
}

const validatePrepared = (recorded: Requested, prepared: PreparedInference): void => {
  if (recorded.fingerprint !== prepared.fingerprint || canonicalInferenceJson(recorded.route) !== canonicalInferenceJson(prepared.route)) throw new Error(`durable inference request ${recorded.requestId} drifted before replay`)
}

const validatePolicy = (recorded: Requested, policy: InferenceAmbiguityPolicy): void => {
  if (canonicalInferenceJson(recorded.policy) !== canonicalInferenceJson(policy)) throw new Error(`durable inference request ${recorded.requestId} changed its ambiguity policy`)
}

export interface InferenceReceipts {
  readonly begin: (input: { readonly requestId: string; readonly callId: string; readonly turn: string; readonly prepared: PreparedInference; readonly policy: InferenceAmbiguityPolicy; readonly position: InferenceAttemptPosition }) => Effect.Effect<InferenceAttemptState>
  readonly decide: (input: { readonly requestId: string; readonly turn: string; readonly fingerprint: string; readonly position: InferenceAttemptPosition; readonly decision: InferenceAttemptDecision }) => Effect.Effect<void>
  readonly retain: (input: { readonly requestId: string; readonly turn: string; readonly fingerprint: string; readonly action: Action }) => Effect.Effect<void>
}

// inferenceReceiptsFrom coordinates one active driver over an authoritative EventLog using agentKeys. A recreated driver treats an unanswered request as an unknown external outcome (durable.test.ts, "simultaneous initial callers reserve one local admission").
export const inferenceReceiptsFrom = (log: Context.Service.Shape<typeof EventLog>): InferenceReceipts => {
  const active = new Set<string>()
  const activeKey = (requestId: string, position: InferenceAttemptPosition) => `${requestId}/${position.attempt}/${position.rung}/${position.retry}`
  return {
    begin: (input) => Effect.suspend(() => {
      const reservation = activeKey(input.requestId, input.position)
      const owned = !active.has(reservation)
      if (owned) active.add(reservation)
      let keep = false
      return Effect.gen(function* () {
        const history = rows(yield* log.read, input.requestId)
        const requested = history.requests.find((event) => samePosition(event.position, input.position))
        if (requested !== undefined) {
          validatePrepared(requested, input.prepared)
          validatePolicy(requested, input.policy)
          if (history.retained !== undefined && history.retained.fingerprint === input.prepared.fingerprint) return { status: "retained" as const, action: finiteJson(history.retained.action), fingerprint: history.retained.fingerprint }
          const decision = history.decisions.find((event) => samePosition(event.position, input.position))
          if (decision !== undefined) return { status: "decided" as const, decision: finiteJson(decision.decision) }
          if (!owned) return { status: "inFlight" as const }
          keep = true
          return { status: "pending" as const }
        }
        if (!owned) return { status: "inFlight" as const }
        if (history.retained !== undefined) throw new Error(`durable inference result ${input.requestId} does not match a recorded request position`)
        const at = yield* Clock.currentTimeMillis
        const token = `${yield* Random.nextInt}:${yield* Random.nextInt}`
        yield* log.append([finiteJson({ type: "InferenceRequested", requestId: input.requestId, callId: input.callId, token, fingerprint: input.prepared.fingerprint, route: input.prepared.route, policy: input.policy, position: input.position, turn: input.turn, at }) as Event])
        const committed = rows(yield* log.read, input.requestId).requests.find((event) => samePosition(event.position, input.position))
        if (committed === undefined) return yield* Effect.die(new Error("inference request append returned without a committed request"))
        validatePrepared(committed, input.prepared)
        validatePolicy(committed, input.policy)
        if (committed.token !== token) return { status: "inFlight" as const }
        keep = true
        return { status: "begun" as const }
      }).pipe(Effect.ensuring(Effect.sync(() => { if (owned && !keep) active.delete(reservation) })))
    }),
    decide: (input) => Effect.uninterruptible(Effect.gen(function* () {
      const history = rows(yield* log.read, input.requestId)
      const prior = history.decisions.find((event) => samePosition(event.position, input.position))
      if (prior !== undefined) {
        if (prior.fingerprint !== input.fingerprint || canonicalInferenceJson(prior.decision) !== canonicalInferenceJson(input.decision)) return yield* Effect.die(new Error(`durable inference decision ${input.requestId}/${input.position.attempt} drifted`))
        active.delete(activeKey(input.requestId, input.position))
        return
      }
      const at = yield* Clock.currentTimeMillis
      yield* log.append([finiteJson({ type: "InferenceAttemptDecided", ...input, at }) as Event])
      const committed = rows(yield* log.read, input.requestId).decisions.find((event) => samePosition(event.position, input.position))
      if (committed === undefined) return yield* Effect.die(new Error("inference decision append returned without a committed decision"))
      if (committed.fingerprint !== input.fingerprint || canonicalInferenceJson(committed.decision) !== canonicalInferenceJson(input.decision)) return yield* Effect.die(new Error(`durable inference decision ${input.requestId}/${input.position.attempt} drifted`))
      active.delete(activeKey(input.requestId, input.position))
    })),
    retain: (input) => Effect.uninterruptible(Effect.gen(function* () {
      const history = rows(yield* log.read, input.requestId)
      if (history.retained !== undefined) {
        if (history.retained.fingerprint !== input.fingerprint || canonicalInferenceJson(history.retained.action) !== canonicalInferenceJson(input.action)) return yield* Effect.die(new Error(`durable inference result ${input.requestId} drifted`))
        for (const key of active) if (key.startsWith(`${input.requestId}/`)) active.delete(key)
        return
      }
      const at = yield* Clock.currentTimeMillis
      yield* log.append([finiteJson({ type: "InferenceResultRetained", ...input, action: finiteJson(input.action), at }) as Event])
      const committed = rows(yield* log.read, input.requestId).retained
      if (committed === undefined) return yield* Effect.die(new Error("inference result append returned without a committed result"))
      if (committed.fingerprint !== input.fingerprint || canonicalInferenceJson(committed.action) !== canonicalInferenceJson(input.action)) return yield* Effect.die(new Error(`durable inference result ${input.requestId} drifted`))
      for (const key of active) if (key.startsWith(`${input.requestId}/`)) active.delete(key)
    }))
  }
}
