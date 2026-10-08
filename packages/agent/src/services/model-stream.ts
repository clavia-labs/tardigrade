import { RuntimeError, type EffectExecution, type ExecutionUpdatePayload } from "@clavia/tardigrade-core"
import type { ModelRef } from "@clavia/tardigrade-model/reference"
import { boundedStream, StreamIncomplete } from "@clavia/tardigrade-model/stream/request"
import type { StreamBounds } from "@clavia/tardigrade-model/stream/policy"
import { Effect, Stream } from "effect"
import { LanguageModel, Prompt, Response, type Tool } from "effect/ai"

export interface ModelCallContext {
  readonly publish: typeof EffectExecution.Service.publish
  readonly purpose: "inference" | "compaction"
}

// ModelDelta carries text or reasoning from a provider stream.
export interface ModelDelta extends ExecutionUpdatePayload {
  readonly type: "model.delta"
  readonly purpose: "inference" | "compaction"
  readonly model: ModelRef
  readonly blockId: string
  readonly kind: "text" | "reasoning"
  readonly text: string
}

// collectModelStream publishes execution updates and collects the provider's completed response (packages/platform/test/bun/execution-stream.test.ts).
export const collectModelStream = <Tools extends Record<string, Tool.Any>, Mode extends Response.ToolParametersMode, E, R>(
  stream: Stream.Stream<Response.StreamPart<Tools, Mode>, E, R>,
  model: ModelRef,
  context: ModelCallContext,
  bounds: StreamBounds,
) => Effect.gen(function* () {
  const parts = yield* stream.pipe(
    stream => boundedStream(stream, bounds),
    Stream.tap(part => part.type === "error" ? Effect.fail(RuntimeError.from(part.error)) : part.type === "text-delta" || part.type === "reasoning-delta"
      ? context.publish({ type: "model.delta", purpose: context.purpose, model, blockId: part.id,
        kind: part.type === "text-delta" ? "text" : "reasoning", text: part.delta } satisfies ModelDelta)
      : Effect.void),
    Stream.runCollect,
  )
  if (!parts.some(part => part.type === "finish")) return yield* new StreamIncomplete()
  const content: Response.Part<Tools, Mode>[] = parts.filter(part =>
    part.type !== "text-start" && part.type !== "text-delta" && part.type !== "text-end" &&
    part.type !== "reasoning-start" && part.type !== "reasoning-delta" && part.type !== "reasoning-end" &&
    part.type !== "tool-params-start" && part.type !== "tool-params-delta" && part.type !== "tool-params-end" && part.type !== "error")
  const continuation = Prompt.fromResponseParts(parts)
  for (const message of continuation.content) {
    if (message.role !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") content.push(Response.makePart(part.type, { text: part.text }))
    }
  }
  return { response: new LanguageModel.GenerateTextResponse<Tools, Mode>(content), continuation }
})
