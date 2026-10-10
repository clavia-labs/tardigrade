import { Schema } from "effect"
import { ObjectRef } from "./reference"

const ByteSize = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))

export const ContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("file"), mediaType: Schema.NonEmptyString, filename: Schema.optionalKey(Schema.String), byteSize: Schema.optionalKey(ByteSize), object: ObjectRef }),
])
export type ContentPart = typeof ContentPart.Type
export const Content = Schema.Array(ContentPart)
export type Content = typeof Content.Type

export type ResolvedContentPart = Extract<ContentPart, { type: "text" }> | {
  readonly type: "file"
  readonly mediaType: string
  readonly filename?: string
  readonly byteSize: number
  readonly bytes: Uint8Array
}
export const InputContentPart = Schema.Union([
  ContentPart,
  Schema.Struct({ type: Schema.Literal("file"), mediaType: Schema.NonEmptyString, filename: Schema.optionalKey(Schema.String), byteSize: Schema.optionalKey(ByteSize), bytes: Schema.Uint8ArrayFromBase64 }),
])
export type InputContentPart = typeof InputContentPart.Type

export const ToolResult = Schema.Struct({ content: Schema.Array(InputContentPart) }).annotate({ "tardigrade/tool/content": true })
export type ToolResult = typeof ToolResult.Type
export const StoredToolResult = Schema.Struct({ content: Content }).annotate({ "tardigrade/tool/content": true })
export type StoredToolResult = typeof StoredToolResult.Type

// isToolResultSchema identifies an explicitly declared content result contract.
export const isToolResultSchema = (schema: Schema.Top): boolean => Schema.resolveAnnotations(schema)?.["tardigrade/tool/content"] === true
