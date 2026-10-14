import { waitFor } from "../wait"
import { Database } from "bun:sqlite"
import { effectService, effectServiceAlarm, effectServiceClient, initialEffectServiceState, type EffectServiceState } from "../effect-service"

// bunEffectService runs an HTTP server with its own SQLite database and timers (operationLifecycle).
export function bunEffectService(filename: string) {
  const db = new Database(filename, { create: true })
  db.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = () => {
    const row = db.query<{ value: string }, []>("SELECT value FROM state WHERE id = 1").get()
    return row ? JSON.parse(row.value) as EffectServiceState : initialEffectServiceState()
  }
  const service = effectService({ read: async () => read(), transaction: async work => {
    const state = read()
    const value = work(state)
    db.query("INSERT OR REPLACE INTO state VALUES (1, ?)").run(JSON.stringify(state))
    if (timer !== undefined) clearTimeout(timer)
    const at = effectServiceAlarm(state)
    if (at !== null) timer = setTimeout(() => { void service.alarm() }, Math.max(0, at - Date.now()))
    return value
  } })
  let pending = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => { pending++; try { return await service.fetch(request) } finally { pending-- } } })
  const client = effectServiceClient(request => globalThis.fetch(new Request(new URL(new URL(request.url).pathname, server.url).toString(), request)))
  return { client, close: async () => { await client.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }); await waitFor(async () => pending, count => count === 0); await client.dispose(); await server.stop(true); if (timer !== undefined) clearTimeout(timer); db.close() } }
}
