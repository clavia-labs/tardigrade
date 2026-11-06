import { readFile } from "node:fs/promises"
import { createLogQueryEngine } from "../shared/log-sql/engine"

export const bunLogQueryEngine = createLogQueryEngine(async () => {
  const load = async (name: string) => WebAssembly.compile(await readFile(new URL(`../shared/log-sql/vendor/${name}.wasm`, import.meta.url)))
  const signatures = ["iiiii", "iiii", "iii", "iiiiii", "ii", "iiiij", "iij", "iiiiiii"]
  const [module, callbacks] = await Promise.all([load("sqlite3"), Promise.all(signatures.map(async signature => [signature, await load(`callback-${signature}`)] as const))])
  return { module, callbacks: Object.fromEntries(callbacks) }
})
