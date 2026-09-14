import { historyOf, importSchema } from "./prompt"
import { actionOf, responseEvidence, errorOf } from "./response"
import { withModelRequest } from "@clavia/tardigrade-model/stream/invocation"
import type { InferDelta } from "../observer"
import type { InferRequest } from "../contract"
import { Duration, Effect } from "effect"
import { AiError, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
import { modelRequest } from "../request"
import type { Action } from "../../log/events"
import { collectResponse } from "@clavia/tardigrade-model/stream/collect"
import { BindingSettings, BindingInvocation } from "./settings"

import { fallbackSystemFor, outputModeOf, outputSchemaFor, outputNameFor } from "./output"

import { StreamIncomplete, StreamBoundExceeded, StreamTruncated } from "@clavia/tardigrade-model/stream/request"

// react translates one Effect response into an action for the inference machine.
export const react = (request: InferRequest, key?: string, signal?: AbortSignal, onDelta?: (delta: InferDelta) => void) => Effect.gen(function* () {
  const options = yield* BindingSettings
  const { provider: providerId, protocol, policy } = options
  const endpoint = { provider: providerId, model: request.model?.model_id ?? options.model }
  const outputPolicy = { ...endpoint, ...(options.output === undefined ? {} : { output: options.output }) }
  if (signal?.aborted) return yield* Effect.interrupt
  return yield* withModelRequest({ identity: request.identity, model: request.model, observedModel: { provider: providerId, model_id: endpoint.model }, key, onDelta }, onPart => Effect.suspend(() => {
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
      const response = yield* Effect.gen(function* () {
        const maxOutputTokens = policy.maxOutputTokens
        observed = []
        const result = yield* collectResponse(Prompt.setSystem(Prompt.fromMessages(history), system), Toolkit.make(...tools), (part) => {
          observed.push(part)
          if (part.type === "finish") reportedCostUsd = options.reportedCostUsd?.(part)
          return onPart(part)
        }, responseFormat, policy.timeout)
        if (result.parts.some((part) => part.type === "finish" && part.reason === "length")) return yield* new StreamTruncated({ maxOutputTokens })
        return result
      }).pipe(
        Effect.provideService(BindingInvocation, { request, key, signal, onDelta })
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
  }))
})
