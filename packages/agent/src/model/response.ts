import { Schema } from "effect"
import { Response } from "effect/unstable/ai"

// ModelUsage preserves Effect's optional token breakdowns in the durable response (response.test.ts).
export const ModelUsage = Schema.toEncoded(Response.Usage)
export type ModelUsage = typeof ModelUsage.Type

// ModelResponse preserves encoded response metadata without the stream discriminator.
export const ModelResponse = Schema.toEncoded(Schema.Struct({
  id: Response.ResponseMetadataPart.fields.id,
  modelId: Response.ResponseMetadataPart.fields.modelId,
  timestamp: Response.ResponseMetadataPart.fields.timestamp,
  request: Response.ResponseMetadataPart.fields.request,
  metadata: Response.ResponseMetadataPart.fields.metadata
}))
export type ModelResponse = typeof ModelResponse.Type

// ModelFinish preserves finish evidence beside the top-level usage field.
export const ModelFinish = Schema.toEncoded(Schema.Struct({
  reason: Response.FinishPart.fields.reason,
  response: Response.FinishPart.fields.response,
  metadata: Response.FinishPart.fields.metadata
}))
export type ModelFinish = typeof ModelFinish.Type

