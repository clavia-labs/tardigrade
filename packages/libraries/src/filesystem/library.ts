import { Effect, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "../library"
import { FilesystemWorkspace } from "./service"

// filesystem declares file and shell tools independently of their host implementation.
export const filesystem = defineLibrary({
  name: "filesystem", description: "Files and a shell in the agent's workspace",
  toolNames: { bash: "bash", read: "read", write: "write", edit: "edit" },
  methods: [
    Rpc.make("bash", { payload: Schema.Struct({ command: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Run a shell command in the workspace and return stdout, stderr, and any nonzero exit code"),
    Rpc.make("read", { payload: Schema.Struct({ path: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Read a file in the workspace; truncated output includes the applied character limit")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("write", { payload: Schema.Struct({ path: Schema.String, content: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Create or overwrite a file in the workspace"),
    Rpc.make("edit", { payload: Schema.Struct({ path: Schema.String, oldText: Schema.String, newText: Schema.String }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Replace one exact nonempty occurrence of oldText in a workspace file"),
  ],
})

// filesystemTools implements the filesystem library through the host's FilesystemWorkspace service.
export const filesystemTools = filesystem.implement({
  bash: ({ command }) => Effect.flatMap(FilesystemWorkspace, workspace => workspace.bash(command)).pipe(Effect.mapError(String)),
  read: ({ path }) => Effect.flatMap(FilesystemWorkspace, workspace => workspace.read(path)).pipe(Effect.mapError(String)),
  write: ({ path, content }) => Effect.flatMap(FilesystemWorkspace, workspace => workspace.write(path, content)).pipe(Effect.as(`Wrote ${path}`), Effect.mapError(String)),
  edit: ({ path, oldText, newText }) => Effect.flatMap(FilesystemWorkspace, workspace => workspace.edit(path, oldText, newText)).pipe(Effect.as(`Edited ${path}`), Effect.mapError(String)),
})
