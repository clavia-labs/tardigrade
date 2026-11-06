import type { Schema } from "effect"

export const LOG_SCENARIO_TIMEOUT_MS = 30_000
export const balanceQuery = "SELECT json_extract(event, '$.code') AS code, SUM(json_extract(event, '$.change')) AS balance FROM events WHERE type = 'BalanceRecorded' AND json_extract(event, '$.account') = 'Cedar' GROUP BY code"

interface BalanceFact { readonly account: string; readonly code: string; readonly change: number }
interface LogDescription {
  readonly types: readonly { readonly type: string | null; readonly declared: boolean; readonly schemas: readonly { readonly text: string; readonly truncated: boolean }[] }[]
}
export interface LogQueryResult { readonly text: string; readonly through: number; readonly truncated: boolean; readonly moreRows: boolean; readonly readEvents: number }
export interface LogSearchResult { readonly hits: readonly { readonly position: number; readonly type: string | null; readonly score: number; readonly snippet: string; readonly truncated: boolean }[]; readonly more: boolean; readonly through: number; readonly indexedThrough: number; readonly policy: { readonly maxScanEvents: number }; readonly indexPolicy: { readonly maxIndexEvents: number } }
export interface LogStatus { readonly records: number; readonly checkpoint: number | null }
export interface LogLifecycleDriver {
  readonly record: (thread: string, fact: BalanceFact, id: string) => Promise<void>
  readonly describe: (thread: string, type?: string | null) => Promise<LogDescription>
  readonly query: (thread: string, sql: string, id: string, through?: number) => Promise<LogQueryResult>
  readonly search: (thread: string, query: string, id: string, options?: { readonly through?: number; readonly type?: string; readonly limit?: number }) => Promise<LogSearchResult>
  readonly loseReply: (thread: string, sql: string, id: string) => Promise<LogStatus>
  readonly status: (thread: string) => Promise<LogStatus>
  readonly restart: () => Promise<void>
  readonly close: () => Promise<void>
}
export type LogRequest =
  | { readonly type: "record"; readonly thread: string; readonly fact: BalanceFact; readonly id: string }
  | { readonly type: "recall"; readonly thread: string; readonly method: "describe" | "query" | "search"; readonly input: Schema.Json; readonly id: string; readonly loseReply?: boolean }
  | { readonly type: "status"; readonly thread: string }
export type LogResponse =
  | { readonly type: "ready" }
  | { readonly type: "boundary"; readonly status: LogStatus }
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "error"; readonly message: string }
