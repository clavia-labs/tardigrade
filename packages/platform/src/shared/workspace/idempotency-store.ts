import { Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { FilesystemWorkspaceError, type WorkspaceIdempotencyRequest, type WorkspaceIdempotencyStore, type WorkspaceMutationOutcome } from "@clavia/tardigrade-libraries/filesystem/index"

const Outcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Union([Schema.String, Schema.Null]) }),
  Schema.TaggedStruct("Failure", { message: Schema.String }),
])
const encode = (outcome: WorkspaceMutationOutcome): string => JSON.stringify(outcome._tag === "Success"
  ? { _tag: "Success", value: outcome.value }
  : { _tag: "Failure", message: outcome.message })
type Row = { readonly input_digest: string; readonly outcome: string | null }

// sqlIdempotencyStore supplies SQL storage for workspace mutation claims and outcomes.
export const sqlIdempotencyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_idempotency (
    workspace_id TEXT NOT NULL, caller_key TEXT NOT NULL, input_digest TEXT NOT NULL,
    outcome TEXT, PRIMARY KEY (workspace_id, caller_key)
  )`
  const validate = (request: WorkspaceIdempotencyRequest) => Effect.try({ try: () => {
    for (const value of [request.workspaceId, request.key, request.inputDigest]) {
      if (typeof value !== "string" || !value.trim()) throw new FilesystemWorkspaceError("Workspace identity, key, and digest must be nonempty")
    }
  }, catch: FilesystemWorkspaceError.from })
  const load = (request: WorkspaceIdempotencyRequest) => sql<Row>`SELECT input_digest, outcome FROM workspace_idempotency WHERE workspace_id = ${request.workspaceId} AND caller_key = ${request.key}`.pipe(Effect.flatMap(rows => rows[0] ? Effect.succeed(rows[0]) : Effect.fail(new FilesystemWorkspaceError("Workspace idempotency record is missing"))))
  const decode = (text: string) => Schema.decodeEffect(Schema.fromJsonString(Outcome))(text).pipe(Effect.mapError(FilesystemWorkspaceError.from))
  return {
    claim: request => sql.withTransaction(Effect.gen(function* () {
      yield* validate(request)
      const inserted = yield* sql<{ caller_key: string }>`INSERT INTO workspace_idempotency (workspace_id, caller_key, input_digest) VALUES (${request.workspaceId}, ${request.key}, ${request.inputDigest}) ON CONFLICT (workspace_id, caller_key) DO NOTHING RETURNING caller_key`
      if (inserted.length) return { _tag: "Acquired" as const }
      const row = yield* load(request)
      if (row.input_digest !== request.inputDigest) return { _tag: "Conflict" as const }
      if (row.outcome === null) return { _tag: "Pending" as const }
      return { _tag: "Completed" as const, outcome: yield* decode(row.outcome) }
    })).pipe(Effect.mapError(FilesystemWorkspaceError.from)),
    complete: (request, outcome) => sql.withTransaction(Effect.gen(function* () {
      yield* validate(request)
      const checked = yield* Schema.decodeEffect(Outcome)(outcome).pipe(Effect.mapError(FilesystemWorkspaceError.from))
      const encoded = encode(checked)
      const updated = yield* sql<{ caller_key: string }>`UPDATE workspace_idempotency SET outcome = ${encoded} WHERE workspace_id = ${request.workspaceId} AND caller_key = ${request.key} AND input_digest = ${request.inputDigest} AND outcome IS NULL RETURNING caller_key`
      if (updated.length) return
      const row = yield* load(request)
      if (row.input_digest !== request.inputDigest || row.outcome === null) return yield* Effect.fail(new FilesystemWorkspaceError("Workspace idempotency completion conflicts with its claim"))
      const saved: WorkspaceMutationOutcome = yield* decode(row.outcome)
      if (encode(saved) !== encoded) return yield* Effect.fail(new FilesystemWorkspaceError("Workspace idempotency outcome cannot change"))
    })).pipe(Effect.mapError(FilesystemWorkspaceError.from)),
  } satisfies WorkspaceIdempotencyStore
}).pipe(Effect.mapError(FilesystemWorkspaceError.from))
