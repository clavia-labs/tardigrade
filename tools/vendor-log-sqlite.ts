import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"

// generateLogSqlite prepares checksum-pinned SQLite assets for the platform loaders.
export async function generateLogSqlite() {
  const root = new URL("../packages/platform/src/shared/log-sql/vendor/", import.meta.url)
  const wasm = new URL(import.meta.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"))
  const javascript = new URL("./index.mjs", wasm)
  const sources = await Promise.all([readFile(javascript), readFile(wasm)])
  const hashes = ["0dcdd860e6ec672623b13b8b8e41bb6c78be7a5df80ec553fc4f69160161c8af", "b8a92a19f441a90ff2339fe988fbe317c4adf3ed844096f12aee04aa72d58257"]
  for (const [index, source] of sources.entries()) if (createHash("sha256").update(source).digest("hex") !== hashes[index]) throw new Error("SQLite source differs from the pinned 3.54.1 build")
  let source = sources[0]!.toString("utf8")
  for (const [before, after] of [
    ["new WebAssembly.Module(new Uint8Array(wasmCode))", 'callbackModules[sig.replace(/[()]/g, "").replace(/[pPs]/g, "i")]'],
    ["globalThis.sqlite3ApiConfig || {}", 'EmscriptenModule["sqlite3ApiConfig"] || {}'],
  ] as const) {
    if (source.split(before).length !== 2) throw new Error(`SQLite patch site differs: ${before}`)
    source = source.replace(before, after!)
  }
  await mkdir(root, { recursive: true })
  const write = async (name: string, contents: string | Uint8Array) => {
    const temporary = new URL(`${name}.${process.pid}.tmp`, root)
    await writeFile(temporary, contents)
    await rename(temporary, new URL(name, root))
  }
  await write("sqlite3.mjs", "let callbackModules\nexport function setCallbackModules(modules) { callbackModules = modules }\n" + source)
  await write("sqlite3.wasm", sources[1]!)
  for (const signature of ["iiiii", "iiii", "iii", "iiiiii", "ii", "iiiij", "iij", "iiiiiii"]) {
    const type = [1, 96, signature.length - 1, ...Array.from(signature.slice(1), letter => letter === "j" ? 126 : 127), 1, 127]
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, type.length, ...type, 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0])
    await write(`callback-${signature}.wasm`, bytes)
  }

  for (const name of ["sqlite3", "callback-iiiii", "callback-iiii", "callback-iii", "callback-iiiiii", "callback-ii", "callback-iiiij", "callback-iij", "callback-iiiiiii"]) {
    await write(`${name}.wasm.d.ts`, "declare const module: WebAssembly.Module\nexport default module\n")
  }
}

if (import.meta.main) await generateLogSqlite()
