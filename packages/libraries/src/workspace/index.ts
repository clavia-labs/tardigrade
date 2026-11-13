import { Context, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { Library, MethodDescription, MethodHints } from "../library"
import { ToolResult } from "@clavia/tardigrade-model/object/content"

export const BashInput = Schema.Struct({ command: Schema.String })
const Line = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const ReadInput = Schema.Struct({ path: Schema.String, offset: Schema.optionalKey(Line), limit: Schema.optionalKey(Line) })
export const WriteInput = Schema.Struct({ path: Schema.String, content: Schema.String })
export const EditInput = Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String })

export const workspace = Library.make("workspace",
  Rpc.make("bash", { payload: BashInput, success: Schema.String, error: Schema.String })
    .annotate(MethodDescription, "Run a shell command in the workspace and return stdout, stderr, and any nonzero exit code"),
  Rpc.make("read", { payload: ReadInput, success: ToolResult, error: Schema.String })
    .annotate(MethodDescription, "Read workspace text or file content. For text, offset is a one-based starting line and limit is the maximum line count; omitted offset starts at line 1. Truncation reports the applied limit and continuation guidance. Binary files are returned whole.")
    .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
  Rpc.make("write", { payload: WriteInput, success: Schema.String, error: Schema.String })
    .annotate(MethodDescription, "Create or overwrite a file in the workspace"),
  Rpc.make("edit", { payload: EditInput, success: Schema.String, error: Schema.String })
    .annotate(MethodDescription, "Replace one exact nonempty occurrence of oldText in a workspace file"),
)

export type Workspace = Context.Service.Identifier<typeof workspace>

export { WorkspaceBackend, WorkspaceError, DEFAULT_WORKSPACE_POLICY, workspacePolicy, workspaceText, editWorkspaceText, type WorkspaceBackendService, type WorkspacePolicy } from "./backend"
export type { WorkspaceMutationOptions, WorkspaceIdempotencyRequest, WorkspaceMutationOutcome, WorkspaceIdempotencyClaim, WorkspaceIdempotencyStore, WorkspaceIdempotencyOptions } from "./idempotency"
export { workspaceIdempotency, WorkspaceIdempotencyError } from "./idempotency"
export { readWorkspaceContent, workspaceReadPolicy, DEFAULT_WORKSPACE_READ_POLICY, type WorkspaceReadResult, type WorkspaceReadRange, type WorkspaceFileContent, type WorkspaceReadPolicy, type WorkspaceReadOptions } from "./read"
