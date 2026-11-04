import { ResponseFormat } from "@tardie/ai"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import type { Response, Tool, Toolkit } from "effect/ai"

import type { StreamBounds } from "./policy"
import { boundedStream, StreamBoundExceeded, StreamIncomplete } from "./request"

// collectResponse preserves provider metadata while leaving tool execution to the caller (providers/response.test.ts).
export const collectResponse = <Tools extends Record<string, Tool.Any>>(prompt: Prompt.RawInput, toolkit: Toolkit.Toolkit<Tools>, onPart?: (part: Response.AnyPart) => void | Effect.Effect<void>, responseFormat?: LanguageModel.ProviderOptions["responseFormat"], bounds?: StreamBounds) =>
  LanguageModel.streamText({ prompt, toolkit, disableToolCallResolution: true }).pipe(
    (stream) => responseFormat === undefined ? stream : Stream.provideService(stream, ResponseFormat, responseFormat),
    (stream) => bounds === undefined ? stream : boundedStream(stream, bounds),
    Stream.tap((part) => Effect.suspend(() => onPart?.(part) ?? Effect.void)),
    Stream.runCollect,
    (effect) => bounds?.attemptMs === undefined ? effect : effect.pipe(Effect.timeoutOrElse({ duration: bounds.attemptMs, orElse: () => Effect.fail(new StreamBoundExceeded({ bound: "attemptMs" })) })),
    Effect.tap((parts) => parts.some((part) => part.type === "finish" || part.type === "error") ? Effect.void : Effect.fail(new StreamIncomplete())),
    Effect.flatMap((parts) => Schema.encodeEffect(Prompt.Prompt)(Prompt.fromResponseParts(parts)).pipe(
      Effect.map((continuation) => ({ parts, continuation }))
    ))
  )
