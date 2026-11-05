import { Effect, Layer, Schema } from "effect"
import { LogSql, LogSqlError, LogSqlResult, type LogSqlPolicy } from "@clavia/tardigrade-libraries"

export const DEFAULT_BUN_LOG_SQL_POLICY: LogSqlPolicy = { timeoutMs: 2_000, maxQueryChars: 8_192, maxSnapshotChars: 2_000_000 }

// bunLogSql evaluates snapshot queries in a disposable SQLite worker (packages/platform/test/scenarios/log/lifecycle.ts).
export function bunLogSql(options: Partial<LogSqlPolicy> = {}) {
  const policy = { ...DEFAULT_BUN_LOG_SQL_POLICY, ...options }
  for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new LogSqlError(`${name} must be a positive safe integer`)
  return Layer.succeed(LogSql, {
    policy,
    query: request => Effect.tryPromise({
      try: signal => new Promise<unknown>((resolve, reject) => {
        if (request.sql.length > policy.maxQueryChars) return reject(new LogSqlError(`SQL exceeds maxQueryChars ${policy.maxQueryChars}`))
        if (JSON.stringify(request.records).length > policy.maxSnapshotChars) return reject(new LogSqlError(`History window exceeds maxSnapshotChars ${policy.maxSnapshotChars}; request a smaller range`))
        const worker = new Worker(new URL("./log-sql.worker.ts", import.meta.url))
        const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate() }
        const abort = () => { stop(); reject(new LogSqlError("Recall SQL interrupted")) }
        const timer = setTimeout(() => { stop(); reject(new LogSqlError(`Recall SQL exceeded timeoutMs ${policy.timeoutMs}`)) }, policy.timeoutMs)
        worker.onmessage = (message: MessageEvent<{ readonly result?: unknown; readonly error?: string }>) => {
          stop()
          if (message.data.error !== undefined) reject(new LogSqlError(message.data.error))
          else resolve(message.data.result)
        }
        worker.onerror = event => { stop(); reject(new LogSqlError(event.message)) }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) return abort()
        worker.postMessage(request)
      }),
      catch: LogSqlError.from,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(LogSqlResult)), Effect.mapError(LogSqlError.from)),
  })
}
