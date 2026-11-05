import { recordEvent } from "@clavia/tardigrade-core"
import { recallSelect } from "../shared/log-sql"
import { Database } from "bun:sqlite"
import type { LogSqlRequest } from "@clavia/tardigrade-libraries"

const worker = globalThis as unknown as { onmessage: (message: MessageEvent<LogSqlRequest>) => void; postMessage: (value: unknown) => void }

worker.onmessage = ({ data }) => {
  const writable = new Database(":memory:")
  let database: Database | undefined
  try {
    writable.exec("CREATE TABLE events (position INTEGER PRIMARY KEY, recorded_at INTEGER, type TEXT, event TEXT NOT NULL, record TEXT NOT NULL)")
    const insert = writable.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
    writable.transaction(() => {
      for (const [index, record] of data.records.entries()) {
        const event = recordEvent(record)
        const type = typeof event === "object" && event !== null && "type" in event && typeof event.type === "string" ? event.type : null
        insert.run(data.from + index, record.recordedAt ?? null, type, JSON.stringify(event), JSON.stringify(record))
      }
    })()
    database = Database.deserialize(writable.serialize(), { readonly: true })
    database.exec("PRAGMA query_only = ON")
    const statement = database.prepare(recallSelect(data.sql))
    try {
      const rows = statement.values(data.limit + 1)
      worker.postMessage({ result: { columns: statement.columnNames, rows: rows.slice(0, data.limit), more: rows.length > data.limit } })
    } finally { statement.finalize() }
  } catch (error) {
    worker.postMessage({ error: error instanceof Error ? error.message : String(error) })
  } finally { database?.close(); writable.close() }
}
