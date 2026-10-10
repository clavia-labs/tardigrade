import { versionedEvent } from "@clavia/tardigrade-core/event/versioned"
import { ToolReturnedV0 } from "./v0"
import { ToolReturnedV1 } from "./v1"

// toolReturnedVersions preserves legacy output literally and prefers explicitly recorded content.
export const toolReturnedVersions = versionedEvent(ToolReturnedV0).to(ToolReturnedV1, ({ output, content, ...fields }) => ({
  ...fields, version: 1, content: content ?? [{ type: "text", text: output ?? "" }],
}))
