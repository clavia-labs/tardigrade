import assert from "node:assert/strict"
import { build } from "esbuild"
import { Miniflare, convertV4MiniflareOptions } from "miniflare"
const source = await build({ entryPoints: [new URL("./workerd/directory-memory.worker.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "neutral", conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], logLevel: "silent" })
const mf = new Miniflare(convertV4MiniflareOptions({ inspectorPort: 0, name: "fixture", modules: true, script: source.outputFiles[0].text, compatibilityDate: "2026-10-06", compatibilityFlags: ["nodejs_compat"], durableObjects: { ACTORS: { className: "DirectoryDO", useSQLite: true }, THREADS: { className: "ThreadDO", useSQLite: true } } }))
let ws
try {
  const request = async (path, body) => {
    const response = await mf.dispatchFetch(`https://fixture${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
    assert.ok(response.ok, await response.clone().text())
    return response.json()
  }
  await request("/seed?start=0&count=0")
  const inspector = await mf.getInspectorURL()
  const httpInspector = new URL(inspector); httpInspector.protocol = "http:"
  const targets = await (await fetch(new URL("/json/list", httpInspector))).json()
  ws = new WebSocket(targets.find(target => target.type === "node" || target.type === "worker")?.webSocketDebuggerUrl ?? targets[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }) })
  const pending = new Map()
  let id = 0, peak = 0
  ws.addEventListener("message", message => { const value = JSON.parse(message.data); const pair = pending.get(value.id); if (pair) { clearTimeout(pair.timer); pending.delete(value.id); if (value.error) pair.reject(Error(value.error.message)); else pair.resolve(value.result) } })
  const cdp = method => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject, timer: setTimeout(() => reject(Error(`Inspector timeout: ${method}`)), 10000) }); ws.send(JSON.stringify({ id: key, method })) })
  const heap = async () => { const result = await cdp("Runtime.getHeapUsage"); peak = Math.max(peak, result.usedSize); return result.usedSize }
  for (let start = 0; start < 2048; start += 32) { await request(`/seed?start=${start}&count=32`); await heap() }
  await request("/seed?start=0&count=2&pending")
  const before = await request("/stats")
  assert.ok(before.bytes > 192 * 1024 * 1024)
  if (process.env.DIRECTORY_MEMORY_CONTROL === "true") {
    let failed = false
    try { await request("/old") } catch { failed = true }
    await heap().catch(() => {})
    assert.ok(failed || peak > 128 * 1024 * 1024, `old reader must exceed the memory envelope: ${peak}`)
    console.log(JSON.stringify({ control: true, failed, legacyBytes: before.bytes, peakHeapBytes: peak }))
  } else {
    let probing = true
    const probe = (async () => { while (probing) { await heap(); await new Promise(resolve => setTimeout(resolve, 10)) } })()
    try {
      for (const thread of ["historical-0", "historical-2047"]) assert.equal((await request(`/lookup?thread=${thread}`)).thread, thread)
      await new Promise(resolve => setTimeout(resolve, 30))
      await request("/recover")
      for (const thread of ["pending-0", "pending-1"]) {
        let found
        for (let attempt = 0; attempt < 300; attempt++) {
          found = await request(`/lookup?thread=${thread}`)
          if (found) break
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        assert.equal(found?.thread, thread, "pending allocation must finish through native recovery")
        const coordinate = await request("/v1/actors/memory/threads", { name: thread })
        assert.equal(coordinate.thread, thread)
        assert.equal(await request(`/calls?thread=${thread}`), 1)
      }
      assert.equal((await request("/v1/actors/memory/threads", { name: "fresh" })).thread, "fresh")
      await mf.dispatchFetch("https://fixture/reopen")
      for (const thread of ["historical-0", "pending-0", "fresh"]) assert.equal((await request(`/lookup?thread=${thread}`)).thread, thread)
      assert.equal(await request("/calls?thread=pending-0"), 1)
      assert.deepEqual(await request("/stats"), before)
    } finally { probing = false; await probe }
    assert.ok(peak < 96 * 1024 * 1024, `directory heap exceeded bound: ${peak}`)
    console.log(JSON.stringify({ control: false, legacyBytes: before.bytes, legacyRecords: before.records, peakHeapBytes: peak, pending: 2 }))
  }
} finally { ws?.close(); await mf.dispose() }
