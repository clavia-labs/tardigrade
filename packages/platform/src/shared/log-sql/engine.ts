import initialize, { setCallbackModules } from "./vendor/sqlite3.mjs"
import type { LogQueryEngine, Sqlite } from "./types"

// createLogQueryEngine initializes SQLite lazily with an isolate-wide heap policy.
export function createLogQueryEngine(load: () => Promise<{ readonly module: WebAssembly.Module; readonly callbacks: Readonly<Record<string, WebAssembly.Module>> }>): LogQueryEngine {
  let pending: Promise<Sqlite> | undefined
  let heap: string | undefined
  return policy => {
    const key = JSON.stringify([policy.initialHeapBytes, policy.maxHeapBytes])
    if (heap !== undefined && key !== heap) return Promise.reject(new Error(`Log SQL heap policy differs from initialized isolate: ${heap}`))
    heap = key
    return pending ??= load().then(({ module, callbacks }) => {
      setCallbackModules(callbacks)
      return initialize({
        wasmMemory: new WebAssembly.Memory({ initial: policy.initialHeapBytes / 65_536, maximum: policy.maxHeapBytes / 65_536 }),
        sqlite3ApiConfig: {
          disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-wl": true, "opfs-sahpool": true } },
          debug: () => {}, warn: () => {}, error: () => {}, log: () => {},
        },
        instantiateWasm: (imports, receive) => {
          const instance = new WebAssembly.Instance(module, imports)
          receive(instance, module)
          return instance.exports
        },
        print: () => {}, printErr: () => {},
      })
    }).catch(error => { pending = undefined; heap = undefined; throw error })
  }
}
