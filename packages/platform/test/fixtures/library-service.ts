import { Context, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { FilesystemWorkspace, Library, MethodDescription, MethodHints } from "@clavia/tardigrade-libraries"

export class Notebook extends Context.Service<Notebook, {
  readonly read: (input: { readonly path: string }) => Effect.Effect<string, string>
  readonly write: (input: { readonly path: string; readonly text: string }) => Effect.Effect<void, string>
}>()("prototype/Notebook") {}

const read = Rpc.make("read", { payload: Schema.Struct({ path: Schema.NonEmptyString }), success: Schema.String, error: Schema.String })
  .annotate(MethodDescription, "Read a research note")
  .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false })
const write = Rpc.make("write", { payload: Schema.Struct({ path: Schema.NonEmptyString, text: Schema.String }), success: Schema.Void, error: Schema.String })
  .annotate(MethodDescription, "Write a research note")
  .annotate(MethodHints, { readOnlyHint: false, openWorldHint: false })

export const notebook = Library.from(Notebook, {
  name: "notes",
  description: "Read and write research notes",
  toolNames: { read: "read_note", write: "write_note" },
  methods: [read, write],
})

export const references = Library.from(Notebook, {
  name: "references",
  description: "Read research references",
  toolNames: { read: "read_reference" },
  methods: [read],
})

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
