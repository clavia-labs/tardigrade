import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import workerd from "workerd"
import encodeBefore from "./image-memory-before.mjs"

const directory = dirname(fileURLToPath(import.meta.url))
const count = Number(process.argv[2] ?? 10)
const bytes = Number(process.argv[3] ?? 524288)
const modes = process.argv[4]?.split(",") ?? ["before", "after", "url"]
if (![count, bytes].every(value => Number.isSafeInteger(value) && value > 0) || modes.some(mode => !["before", "after", "url"].includes(mode))) throw new Error("Usage: bun run image-memory.mjs [image-count] [bytes-per-image] [before,after,url]")
const temporary = await mkdtemp(join(tmpdir(), "image-memory-"))
const response = { id: "fixture", created_at: 1, model: "fixture", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
const received = []
const sink = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname.startsWith("/images/")) {
    const image = Number(url.pathname.split("/").at(-1))
    return new Response(Uint8Array.from({ length: Number(url.searchParams.get("bytes")) }, (_, at) => (at + image) % 256), { headers: { "content-type": "image/png" } })
  }
  const body = new Uint8Array(await request.arrayBuffer())
  const value = JSON.parse(new TextDecoder().decode(body))
  let fetchedImages = 0, fetchedBytes = 0
  for (const item of value.input) for (const part of item.content ?? []) if (part.type === "input_image" && part.image_url.startsWith("http")) {
    const image = new Uint8Array(await (await fetch(part.image_url)).arrayBuffer())
    const index = Number(new URL(part.image_url).pathname.split("/").at(-1))
    if (!image.every((byte, at) => byte === (at + index) % 256)) throw new Error("Referenced image differs")
    fetchedImages++
    fetchedBytes += image.byteLength
  }
  received.push({ bytes: body.byteLength, sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"), fetchedImages, fetchedBytes })
  return new Response(`data: ${JSON.stringify({ type: "response.completed", sequence_number: 0, response })}\n\n`, { headers: { "content-type": "text/event-stream" } })
} })

async function connect(port) {
  let targets
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch("http://127.0.0.1:18799/health")
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (targets.length) break
    } catch {}
    await Bun.sleep(50)
  }
  if (!targets?.length) throw new Error("Inspector did not start")
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let next = 0
  const pending = new Map()
  const samples = []
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.onmessage = async event => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const promise = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) promise.reject(new Error(JSON.stringify(message.error)))
      else promise.resolve(message.result)
    } else if (message.method === "Debugger.paused") {
      try {
        const stage = await send("Debugger.evaluateOnCallFrame", { callFrameId: message.params.callFrames[0].callFrameId, expression: "globalThis.imageMemoryStage", returnByValue: true })
        const usage = await send("Runtime.getHeapUsage")
        samples.push({ stage: stage.result.value, ...usage })
      } catch (error) { console.error(error) } finally { await send("Debugger.resume") }
    }
  }
  await send("Debugger.enable")
  return { samples, close: () => ws.close() }
}

try {
  for (const mode of modes) {
    const output = join(temporary, `${mode}.js`)
    const before = encodeBefore.toString()
    const build = await Bun.build({ entrypoints: [join(directory, "image-memory.worker.ts")], target: "browser", external: ["node:*"], write: false, plugins: [{ name: "encoding-probe", setup(build) {
      build.onLoad({ filter: /packages\/agent\/src\/services\/model\.ts$/ }, async args => ({
        contents: (await readFile(args.path, "utf8")).replace("const objects = yield* resolveContentObjects(input.context, imageTransport, resolved.model)", "const objects = yield* resolveContentObjects(input.context, imageTransport, resolved.model); globalThis.imageMemoryStage = 'resolved'; debugger;"),
        loader: "ts",
      }))
      build.onLoad({ filter: /effect\/dist\/Encoding\.js$/ }, async args => {
        let contents = await readFile(args.path, "utf8")
        if (mode === "before") {
          const start = contents.indexOf("const base64EncodeUint8Array =")
          const end = contents.indexOf("\nfunction getBase64Code", start)
          contents = contents.slice(0, start) + before.replace("function encodeBefore", "function base64EncodeUint8Array") + contents.slice(end)
        }
        contents = contents.replace(/export const encodeBase64 = input => ([^;]+);/, (_, expression) => `export const encodeBase64 = input => { const result = ${expression}; globalThis.imageMemoryStage = 'base64'; debugger; return result; };`)
        return { contents, loader: "js" }
      })
    } }] })
    if (!build.success) throw new Error(build.logs.join("\n"))
    await Bun.write(output, build.outputs[0])
    const config = join(temporary, `${mode}.capnp`)
    await Bun.write(config, `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (modules = [(name = "worker.js", esModule = embed "${mode}.js")], compatibilityDate = "2026-08-08")), (name = "internet", network = (allow = ["local"]))],
  sockets = [(name = "http", address = "127.0.0.1:18799", http = (), service = "main")]
);`)
    const child = Bun.spawn([workerd, "serve", config, "--inspector-addr=127.0.0.1:19339"], { stdout: "ignore", stderr: "inherit" })
    let inspector
    try {
      inspector = await connect(19339)
      const result = await fetch(`http://127.0.0.1:18799/?count=${count}&bytes=${bytes}&transport=${mode === "url" ? "url" : "inline"}&endpoint=${encodeURIComponent(`http://127.0.0.1:${sink.port}`)}`)
      if (!result.ok) throw new Error(await result.text())
      const details = await result.json()
      const wire = received.at(-1)
      if (mode === "url" && (details.imageReads !== 0 || wire.fetchedImages !== count || wire.fetchedBytes !== count * bytes)) throw new Error("URL transport did not fetch every image without actor hydration")
      console.log(JSON.stringify({ mode, request: details, samples: inspector.samples, wire }))
    } finally {
      inspector?.close()
      child.kill()
      await child.exited
    }
  }
  if (modes.includes("before") && modes.includes("after") && received[modes.indexOf("before")].sha256 !== received[modes.indexOf("after")].sha256) throw new Error("Inline request bodies differ")
} finally {
  sink.stop(true)
  await rm(temporary, { recursive: true, force: true })
}
