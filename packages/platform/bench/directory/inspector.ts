import type { Miniflare } from "miniflare"

export interface HeapUsage {
  readonly usedSize: number
  readonly totalSize: number
  readonly embedderHeapUsedSize?: number
  readonly backingStorageSize: number
}

// directoryInspector samples the user worker isolate rather than the benchmark driver process.
export async function directoryInspector(runtime: Miniflare, timeoutMs: number) {
  const url = await runtime.getInspectorURL()
  url.protocol = "http:"
  url.pathname = "/json/list"
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Inspector discovery failed: ${response.status}`)
  const targets = await response.json() as { id: string; webSocketDebuggerUrl: string }[]
  const target = targets.find(target => target.id.startsWith("core:user:"))
  if (!target) throw new Error("User worker inspector target is missing")
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextId = 0
  const rejectAll = (error: Error) => { for (const entry of pending.values()) entry.reject(error); pending.clear() }
  socket.addEventListener("close", () => rejectAll(new Error("Inspector closed")))
  socket.addEventListener("error", () => rejectAll(new Error("Inspector connection failed")))
  socket.addEventListener("message", message => {
    const result = JSON.parse(String(message.data)) as { id?: number; result?: unknown; error?: unknown }
    if (result.id === undefined) return
    const entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id)
    if (result.error) entry.reject(new Error(JSON.stringify(result.error)))
    else entry.resolve(result.result)
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Inspector connection timed out")); socket.close() }, timeoutMs)
      socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Inspector connection failed")) }, { once: true })
    })
  } catch (error) { socket.close(); throw error }
  const send = <Value>(method: string): Promise<Value> => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeoutMs)
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value as Value) }, reject: error => { clearTimeout(timer); reject(error) } })
    try { socket.send(JSON.stringify({ id, method })) }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
  })
  await send("HeapProfiler.enable")
  return {
    target: target.id,
    usage: async () => {
      const usage = await send<HeapUsage>("Runtime.getHeapUsage")
      if (![usage.usedSize, usage.backingStorageSize].every(value => Number.isFinite(value) && value >= 0)) throw new Error("Inspector heap or backing-storage measurement is missing")
      return usage
    },
    collect: () => send("HeapProfiler.collectGarbage"),
    close: () => { rejectAll(new Error("Inspector closed")); socket.close() },
  }
}
