import { SqlError } from "effect/sql"
import { WorkspaceError } from "@clavia/tardigrade-libraries/workspace/index"

// workspaceStorageError distinguishes SQL storage failures while retaining their driver causes (test/bun/workspace/lifecycle.test.ts).
export const workspaceStorageError = (error: unknown): WorkspaceError => SqlError.isSqlError(error)
  ? new WorkspaceError(`Workspace storage failed (${error.reason._tag}, ${error.reason.operation ?? "SQL"}): ${error.message}`, { cause: error })
  : WorkspaceError.from(error)
