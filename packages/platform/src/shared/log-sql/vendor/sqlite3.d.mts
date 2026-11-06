import type { Sqlite } from "../types"

export function setCallbackModules(modules: Readonly<Record<string, WebAssembly.Module>>): void
export default function initialize(options: {
  wasmMemory: WebAssembly.Memory
  sqlite3ApiConfig: {
    disable: { vfs: Record<string, boolean> }
    debug: () => void
    warn: () => void
    error: () => void
    log: () => void
  }
  instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => WebAssembly.Exports
  print: () => void
  printErr: () => void
}): Promise<Sqlite>
