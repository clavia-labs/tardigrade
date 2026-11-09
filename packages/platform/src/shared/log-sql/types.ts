import type { Recorded } from "@clavia/tardigrade-core"

export interface LogQueryPolicy {
  readonly pageSize: number
  readonly maxReadEvents: number
  readonly maxReadBytes: number
  readonly maxQueryChars: number
  readonly maxInstructions: number
  readonly progressEvery: number
  readonly maxResultBytes: number
  readonly maxValueBytes: number
  readonly maxColumns: number
  readonly maxExprDepth: number
  readonly initialHeapBytes: number
  readonly maxHeapBytes: number
}

export const DEFAULT_LOG_QUERY_POLICY: LogQueryPolicy = {
  pageSize: 64, maxReadEvents: 100_000, maxReadBytes: 16_000_000, maxQueryChars: 8_192,
  maxInstructions: 10_000_000, progressEvery: 1_000, maxResultBytes: 64_000,
  maxValueBytes: 1_000_000, maxColumns: 64, maxExprDepth: 100,
  initialHeapBytes: 8 * 1_024 * 1_024, maxHeapBytes: 32 * 1_024 * 1_024,
}

export interface LogQuerySource {
  readonly readPosition: () => number
  readonly readRange: (from: number, to: number) => readonly Recorded<unknown>[]
}

interface Disposable { dispose(): void }
interface Struct extends Disposable { readonly pointer: number }
interface Constraint extends Disposable { readonly $usable: number; readonly $iColumn: number; readonly $op: number }
interface ConstraintUsage extends Disposable { $argvIndex: number; $omit: number }
interface IndexInfo extends Disposable {
  readonly $nConstraint: number
  $estimatedCost: number
  $estimatedRows: bigint
  $idxNum: number
  nthConstraint(index: number): Constraint
  nthConstraintUsage(index: number): ConstraintUsage
}
interface Statement {
  getColumnNames(columns: string[]): void
  step(): boolean
  get(row: unknown[]): unknown[]
  finalize(): void
}
interface Database { readonly pointer: number; exec(sql: string): void; prepare(sql: string): Statement; close(): void }

// Sqlite describes the upstream SQLite WASM APIs used by the read-only bridge.
export interface Sqlite {
  readonly capi: Record<"SQLITE_OK" | "SQLITE_ERROR" | "SQLITE_DENY" | "SQLITE_SELECT" | "SQLITE_READ" | "SQLITE_FUNCTION" | "SQLITE_RECURSIVE" | "SQLITE_INNOCUOUS" | "SQLITE_DBCONFIG_DEFENSIVE" | "SQLITE_INDEX_CONSTRAINT_EQ" | "SQLITE_LIMIT_LENGTH" | "SQLITE_LIMIT_COLUMN" | "SQLITE_LIMIT_EXPR_DEPTH" | "SQLITE_LIMIT_SQL_LENGTH", number> & {
    readonly sqlite3_module: new () => Disposable & { setupModule(options: { catchExceptions: boolean; methods: Record<string, boolean | ((...args: number[]) => number)> }): Struct }
    sqlite3_declare_vtab(db: number, schema: string): number
    sqlite3_create_module(db: number, name: string, module: Struct, aux: number): number
    sqlite3_value_to_js(pointer: number): unknown
    sqlite3_result_js(context: number, value: unknown): void
    sqlite3_limit(db: number, kind: number, value: number): number
    sqlite3_set_authorizer(db: number, callback: (ctx: number, action: number, table: string | null, column: string | null) => number, ctx: number): number
    sqlite3_db_config(db: number, option: number, value: number, output: number): number
    sqlite3_stmt_readonly(statement: number): number
    sqlite3_progress_handler(db: number, every: number, callback: () => number, ctx: number): void
    sqlite3_prepare_v3(db: number, sql: number, length: number, flags: number, statement: number, tail: number): number
    sqlite3_finalize(statement: number): number
  }
  readonly wasm: {
    peekPtr(pointer: number): number
    peek8(pointer: number): number
    pokePtr(pointer: number | number[], value: number): void
    scopedAllocPush(): number
    scopedAllocPop(scope: number): void
    scopedAllocCString(text: string): number
    scopedAllocPtr(count: 2): [number, number]
  }
  readonly vtab: {
    readonly xVtab: { create(output: number): Struct; dispose(pointer: number): void }
    readonly xCursor: { create(output: number): Struct; dispose(pointer: number): void }
    xIndexInfo(pointer: number): IndexInfo
    xRowid(output: number, value: number): void
  }
  readonly oo1: { readonly DB: { new (filename: string, flags: string): Database; checkRc(db: Database, code: number): void } }
}

export type LogQueryEngine = (policy: LogQueryPolicy) => Promise<Sqlite>
