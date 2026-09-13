import { Effect } from "effect"
import { Toolkit, type Response } from "effect/unstable/ai"
import { collectResponse } from "@clavia/tardigrade-model/stream/collect"
import { withModelRequest } from "@clavia/tardigrade-model/stream/invocation"
import { BindingSettings } from "@clavia/tardigrade-model/settings"
import type { InferenceIdentity } from "@clavia/tardigrade-model/stream/observer"
import type { ModelRef } from "@clavia/tardigrade-model/reference"
import { unknownModelError } from "@clavia/tardigrade-model/error"

// summarize accepts a nonempty completed summary without tool calls (component/compaction.test.ts).
export const summarize = (prompt: string, identity: InferenceIdentity, model?: ModelRef) => Effect.gen(function* () {
  const settings = yield* BindingSettings
  const response = yield* withModelRequest({ identity, model, key: identity.turn }, onPart =>
    collectResponse(prompt, Toolkit.make(), onPart, undefined, settings.policy.timeout)
  )
  const parts: ReadonlyArray<Response.AnyPart> = response.parts
  const error = parts.find(part => part.type === "error")
  if (error?.type === "error") return yield* unknownModelError(error.error)
  const finish = parts.findLast(part => part.type === "finish")
  const text = parts.flatMap(part => part.type === "text-delta" ? [part.delta] : []).join("")
  if ((finish?.reason !== "stop" && finish?.reason !== "tool-calls") || parts.some(part => part.type === "tool-call") || text.trim() === "") {
    return yield* unknownModelError("Compaction requires a nonempty completed summary without tool calls")
  }
  return text
})
