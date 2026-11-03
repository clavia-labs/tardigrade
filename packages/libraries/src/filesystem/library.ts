import { Effect, Option, Schema } from "effect"
import { EffectExecution } from "@clavia/tardigrade-core"
import { Rpc } from "effect/unstable/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "../library"
import { FilesystemWorkspace, type FilesystemWorkspaceService } from "./service"
import { ToolResult } from "@clavia/tardigrade-model/object/content"

// filesystem declares file and shell tools independently of their host implementation.
export const filesystem = defineLibrary({
  name: "filesystem", description: "Files and a shell in the agent's workspace",
  toolNames: { bash: "bash", read: "read", write: "write", edit: "edit" },
  methods: [
    Rpc.make("bash", { payload: Schema.Struct({ command: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Run a shell command in the workspace and return stdout, stderr, and any nonzero exit code"),
    Rpc.make("read", { payload: Schema.Struct({ path: Schema.String, offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))), limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))) }), success: ToolResult, error: Schema.String })
      .annotate(MethodDescription, "Read workspace text or file content. For text, offset is a one-based starting line and limit is the maximum line count; omitted offset starts at line 1. Truncation reports the applied limit and continuation guidance. Binary files are returned whole.")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("write", { payload: Schema.Struct({ path: Schema.String, content: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Create or overwrite a file in the workspace"),
    Rpc.make("edit", { payload: Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Replace one exact nonempty occurrence of oldText in a workspace file"),
  ],
})

// filesystemTools implements the filesystem library through the host's FilesystemWorkspace service.
export const filesystemTools = filesystem.implement({
  bash: ({ command }, { requestId }) => mutation(requestId, (workspace, options) => workspace.bash(command, options)),
  read: ({ path, ...range }) => Effect.flatMap(FilesystemWorkspace, workspace => workspace.read(path, range)).pipe(Effect.map(value => ({ content: [typeof value === "string" ? { type: "text" as const, text: value } : value] })), Effect.mapError(String)),
  write: ({ path, content }, { requestId }) => mutation(requestId, (workspace, options) => workspace.write(path, content, options)).pipe(Effect.as(`Wrote ${path}`)),
  edit: ({ path, oldText, newText }, { requestId }) => mutation(requestId, (workspace, options) => workspace.edit(path, oldText, newText, options)).pipe(Effect.as(`Edited ${path}`)),
})

// mutation supplies keys derived from tool invocation identity.
function mutation<Value>(requestId: string | number, execute: (workspace: FilesystemWorkspaceService, options: { readonly idempotencyKey: string } | undefined) => Effect.Effect<Value, Error>) {
  return Effect.gen(function* () {
    const workspace = yield* FilesystemWorkspace
    if (!workspace.idempotency) return yield* execute(workspace, undefined)
    const current = yield* Effect.serviceOption(EffectExecution)
    const ref = Option.isSome(current) ? current.value.ref : undefined
    const idempotencyKey = JSON.stringify(["filesystem-tool-v1", ref ? [ref.seq, ref.atom, ref.act] : null, String(requestId)])
    return yield* execute(workspace, { idempotencyKey })
  }).pipe(Effect.mapError(String))
}
