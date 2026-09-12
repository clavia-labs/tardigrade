import { historyOf, importSchema } from "./prompt"
import { actionOf, responseEvidence, errorOf } from "./response"
import { observerPolicyOf, deltaDelivery } from "./observer"
import type { InferDelta } from "../inference/observer"
import type { InferRequest } from "../inference/contract"
import { FetchHttpClient } from "effect/unstable/http"
import { Duration, Effect, Option } from "effect"
import { AiError, IdGenerator, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
import { modelRequest } from "../inference/request"
import type { Action } from "../log/events"
import { collectResponse } from "./collect"
import { BindingSettings, BindingInvocation, CurrentModel, ProviderRequestKey } from "./settings"

import { fallbackSystemFor, outputModeOf, outputSchemaFor, outputNameFor } from "./output"

import { StreamIncomplete, StreamBoundExceeded, StreamTruncated } from "./request"

// react translates one Effect response into an action for the inference machine.
export const react = (request: InferRequest, key?: string, signal?: AbortSignal, onDelta?: (delta: InferDelta) => void) => Effect.gen(function* () {
  const options = yield* BindingSettings
  const { provider: providerId, protocol, policy } = options
  const endpoint = { provider: providerId, model: request.model?.model_id ?? options.model }
  const outputPolicy = { ...endpoint, ...(options.output === undefined ? {} : { output: options.output }) }
  const observerPolicy = options.observer === undefined ? undefined : observerPolicyOf(options.observer)
  if (signal?.aborted) return yield* Effect.interrupt
  const delivery = options.observer === undefined || observerPolicy === undefined ? undefined : yield* deltaDelivery(options.observer, observerPolicy)
  return yield* Effect.suspend(() => {
    let reportedCostUsd: number | undefined
    let observed: Response.AnyPart[] = []
    let modeEvidence: Pick<Action, "mode"> = {}
    return Effect.gen(function* () {
      const req = modelRequest(request.trajectory, request, request.context ?? {})
      const selected = outputModeOf(req, outputPolicy)
      if ("errors" in selected) return {
        kind: "fail", error: AiError.make({ module: "Tardigrade", method: "inference", reason: AiError.InvalidRequestError.make({ description: selected.errors.join("\n") }) }), endpoint,
        failure: { cause: "output_unsupported", attempts: 0, policy: outputPolicy }
      } satisfies Action
      const mode = selected.mode
      modeEvidence = req.output === undefined ? {} : { mode }
      const fallbackSystem = fallbackSystemFor(req.output, mode)
      const system = fallbackSystem === undefined ? req.system : `${req.system}\n\n${fallbackSystem}`
      const outputSchema = outputSchemaFor(req.output, mode)
      const responseFormat = outputSchema === undefined ? undefined : {
        type: "json" as const, objectName: outputNameFor(req.output, mode)!,
        schema: yield* Effect.try(() => importSchema(outputSchema, options.schemaImport))
      }
      const tools = yield* Effect.try(() => req.tools.map((spec) => Tool.dynamic(spec.name, {
        description: spec.description,
        parameters: importSchema(spec.inputSchema, options.schemaImport),
        failureMode: "return"
      })))
      const history = yield* Effect.try(() => historyOf(req.messages, { provider: providerId, protocol, model: endpoint.model }))
      const transport = Option.getOrElse(yield* Effect.serviceOption(FetchHttpClient.RequestInit), () => ({}))
      const fetchOptions = { ...transport, timeout: false }
      const response = yield* Effect.gen(function* () {
        const maxOutputTokens = policy.maxOutputTokens
        observed = []
        let sequence = 0
        let blockIndex = -1
        const physicalAttempt = yield* IdGenerator.defaultIdGenerator.generateId()
        const result = yield* collectResponse(Prompt.setSystem(Prompt.fromMessages(history), system), Toolkit.make(...tools), (part) => {
          observed.push(part)
          if (part.type === "finish") reportedCostUsd = options.reportedCostUsd?.(part)
          if (part.type === "text-start" || part.type === "reasoning-start") blockIndex += 1
          if (part.type === "text-delta" || part.type === "reasoning-delta") {
            const delta: InferDelta = { ...request.identity, logicalAttempt: key ?? request.identity.turn, physicalAttempt, model: { provider: providerId, model_id: endpoint.model }, blockIndex: Math.max(0, blockIndex), sequence: sequence++, text: part.delta, ...(part.type === "reasoning-delta" ? { kind: "reasoning" as const } : {}) }
            onDelta?.(delta)
            return delivery?.offer(delta).pipe(Effect.asVoid)
          }
        }, responseFormat, policy.timeout)
        if (result.parts.some((part) => part.type === "finish" && part.reason === "length")) return yield* new StreamTruncated({ maxOutputTokens })
        return result
      }).pipe(
        Effect.provideService(BindingInvocation, { request, key, signal, onDelta }),
        Effect.provideService(CurrentModel, request.model),
        Effect.provideService(ProviderRequestKey, key),
        Effect.provideService(FetchHttpClient.RequestInit, fetchOptions)
      )
      const evidence = responseEvidence(response.parts)
      const served = {
        ...modeEvidence,
        endpoint,
        ...evidence,
        continuation: { protocol, provider: providerId, model: endpoint.model, endpoint: options.endpoint, payload: response.continuation },
      }
      return yield* actionOf(response.parts, served, 1)
    }).pipe(
      (effect) => signal === undefined ? effect : Effect.raceFirst(effect, Effect.callback<never>((resume) => {
        const abort = () => resume(Effect.interrupt)
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
        return Effect.sync(() => signal.removeEventListener("abort", abort))
      })),
      Effect.catch((error) => Effect.gen(function*() {
        const cause = error
        const failure = cause instanceof StreamTruncated
          ? AiError.make({ module: "Tardigrade", method: "inference", reason: AiError.UnknownError.make({ description: `The response reached the ${cause.maxOutputTokens}-token output limit.`, metadata: { tardigrade: { maxOutputTokens: cause.maxOutputTokens } } }) })
          : yield* errorOf(cause)
        return {
          kind: "fail",
          error: failure,
          ...modeEvidence,
          endpoint,
          ...responseEvidence(observed),
          retryable: cause instanceof StreamIncomplete || cause instanceof StreamBoundExceeded || (AiError.isAiError(cause) && cause.isRetryable),
          ...(AiError.isAiError(cause) && cause.retryAfter !== undefined ? { retryAfterMs: Duration.toMillis(cause.retryAfter) } : {}),
          failure: { cause: cause instanceof StreamTruncated ? "output_limit" : "inference_error", attempts: 1 }
        } satisfies Action
      })),
      Effect.map((action): Action => reportedCostUsd === undefined ? action : { ...action, reportedCostUsd }))
  }).pipe(Effect.ensuring(delivery?.finish ?? Effect.void))
})
