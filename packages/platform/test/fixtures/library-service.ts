import { Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { FilesystemWorkspace, Library, MethodDescription, MethodHints } from "@clavia/tardigrade-libraries"

export class Notebook extends Library.Service<Notebook>()("prototype/Notebook", {
  name: "notes",
  description: "Read and write research notes",
  toolNames: { read: "read_note", write: "write_note" },
  methods: [
    Rpc.make("read", { payload: Schema.Struct({ path: Schema.NonEmptyString }), success: Schema.String, error: Schema.String })
      .annotate(MethodDescription, "Read a research note")
      .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    Rpc.make("write", { payload: Schema.Struct({ path: Schema.NonEmptyString, text: Schema.String }), success: Schema.Void, error: Schema.String })
      .annotate(MethodDescription, "Write a research note")
      .annotate(MethodHints, { readOnlyHint: false, openWorldHint: false }),
  ],
}) {}

// notebookLayer supplies the service from a filesystem backend (bun/library-service.test.ts).
export const notebookLayer = (backend: Layer.Layer<FilesystemWorkspace, Error>) => Layer.effect(Notebook, Effect.gen(function* () {
  const files = yield* FilesystemWorkspace
  return {
    read: ({ path }) => files.read(path).pipe(
      Effect.mapError(String),
      Effect.flatMap(content => typeof content === "string" ? Effect.succeed(content) : Effect.fail("Notes require text files")),
    ),
    write: ({ path, text }) => files.write(path, text).pipe(Effect.mapError(String)),
  } satisfies typeof Notebook.Service
})).pipe(Layer.provide(backend))
