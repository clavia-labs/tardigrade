import type { SqlError } from "effect/sql"

// sqlErrorMessage describes the driver's failure category and operation.
export const sqlErrorMessage = (error: SqlError.SqlError): string =>
  `(${error.reason._tag}, ${error.reason.operation ?? "SQL"}): ${error.message}`
