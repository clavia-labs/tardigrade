import { Effect, Schema } from "effect"
import { AiError, Response } from "effect/unstable/ai"
import { type Action, type ToolCall } from "../log/events"
import { ToolCallValidationError } from "./collect"
import { unknownModelError } from "../inference/error"

/**
 * actionOf translates Effect response parts into the agent's Action contract.
 * The agent records response evidence as ModelReturned; its persisted schema is
 * in packages/agent/src/log/events.ts (ModelReturned).
 *
 * ModelReturned
 * ├── response      Response ID, model, timestamp, and provider metadata
 * ├── finish        Finish reason, HTTP response, and provider metadata
 * ├── text          Partial prose on failure
 * ├── reasoning     Readable reasoning
 * ├── continuation  Native replay payload (packages/agent/src/inference/continuation.ts)
 * ├── usage         Token breakdowns (packages/agent/src/inference/response.ts)
 * ├── endpoint      Serving provider and model
 * └── error         Structured failure
 *
 * The agent adds callId, ordinal, outcome, turn, epoch, and at when recording.
 * A successful response can be recorded as:
 *
 * {
 *   "type": "ModelReturned",
 *   "callId": "attempt-1",
 *   "ordinal": 0,
 *   "outcome": "returned",
 *   "response": { "id": "resp_123", "modelId": "gpt-5" },
 *   "finish": { "reason": "stop", "metadata": { "openai": { "serviceTier": "default" } } },
 *   "usage": { "inputTokens": { "total": 12 }, "outputTokens": { "total": 3 } },
 *   "endpoint": { "provider": "openai", "model": "gpt-5" },
 *   "turn": "turn-1",
 *   "epoch": 0,
 *   "at": 1700000000000
 * }
 */
export const actionOf = (parts: ReadonlyArray<Response.AnyPart>, served: Pick<Action, "mode" | "endpoint" | "continuation" | "response" | "reasoning" | "finish" | "usage"> & { readonly text?: string }, attempts: number) => Effect.gen(function* () {
    const calls: ToolCall[] = []
    const errors: AiError.AiError[] = []
    for (const part of parts) {
      if (part.type === "tool-call") calls.push({ callId: part.id, name: part.name, arguments: part.params })
      if (part.type === "error") {
        if (!Schema.is(ToolCallValidationError)(part.error)) {
          errors.push(yield* errorOf(part.error))
          continue
        }
        const error = part.error
        calls.push({ callId: error.id, name: error.name, arguments: error.params, validationError: JSON.stringify(error.cause) })
      }
    }
    if (errors.length > 0) return { kind: "fail", ...served, error: errors.length === 1 ? errors[0]! : unknownModelError(yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(AiError.AiError)))(errors)), failure: { cause: "inference_error", attempts: attempts } } satisfies Action
    const finish = served.finish?.reason
    if (finish !== "stop" && finish !== "tool-calls") return {
      kind: "fail", ...served,
      error: unknownModelError(`Effect AI response did not finish successfully: ${finish ?? "missing finish"}`),
      failure: { cause: finish === "content-filter" ? "refused" : "inference_error", attempts: attempts }
    } satisfies Action
    const text = served.text ?? ""
    return calls.length > 0
      ? { kind: "calls", calls: [calls[0]!, ...calls.slice(1)], text, ...served } satisfies Action
      : { kind: "complete", output: text, ...served } satisfies Action
})

// responseEvidence extracts model prose, readable reasoning, and response metadata for Action.
export const responseEvidence = (parts: ReadonlyArray<Response.AnyPart>) => {
  let text = ""
  let reasoning = ""
  let response: Action["response"]
  let finish: Action["finish"]
  let usage: Action["usage"]
  for (const part of parts) {
    if (part.type === "text-delta") text += part.delta
    if (part.type === "reasoning-delta") reasoning += part.delta
    if (part.type === "response-metadata") {
      const encoded: Response.ResponseMetadataPartEncoded = JSON.parse(Schema.encodeSync(Schema.fromJsonString(Response.ResponseMetadataPart))(part))
      const { type: _type, ...metadata } = encoded
      response = { ...response, ...metadata, metadata: { ...response?.metadata, ...metadata.metadata } }
    }
    if (part.type === "finish") {
      const encoded: Response.FinishPartEncoded = JSON.parse(Schema.encodeSync(Schema.fromJsonString(Response.FinishPart))(part))
      const { type: _type, usage: tokens, ...evidence } = encoded
      usage = tokens
      finish = evidence
    }
  }
  return {
    ...(text === "" ? {} : { text }), ...(reasoning === "" ? {} : { reasoning }),
    ...(response === undefined ? {} : { response }), ...(finish === undefined ? {} : { finish }),
    ...(usage === undefined ? {} : { usage })
  }
}

// errorOf uses the native error codec to preserve redacted HTTP evidence (binding/errors.test.ts).
export const errorOf = (cause: unknown): Effect.Effect<AiError.AiError> => Effect.succeed(unknownModelError(cause))
