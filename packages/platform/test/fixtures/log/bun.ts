import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { join } from "node:path"
import { testStage } from "../wait"
import type { LogLifecycleDriver, LogRequest, LogResponse } from "./shared"

// bunLogLifecycle hosts a durable recall actor in a killable subprocess.
export async function bunLogLifecycle(): Promise<LogLifecycleDriver> {
  const directory = await mkdtemp(join(tmpdir(), "tardie-log-lifecycle-"))
  const start = () => {
    const child = Bun.spawn([process.execPath, new URL("./bun-process.ts", import.meta.url).pathname, directory], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    return { child, reader: createInterface({ input: Readable.fromWeb(child.stdout) })[Symbol.asyncIterator](), errors: new Response(child.stderr).text() }
  }
  let current: ReturnType<typeof start> | undefined
  const next = async (): Promise<LogResponse> => {
    assert.ok(current)
    const line = await current.reader.next()
    if (line.done) throw new Error(`Log process exited: ${await current.errors}`)
    const response = JSON.parse(line.value) as LogResponse
    if (response.type === "error") throw new Error(response.message)
    return response
  }
  const launch = () => testStage("starting log lifecycle process", async () => { current = start(); assert.equal((await next()).type, "ready") })
  const kill = () => testStage("stopping log lifecycle process", async () => {
    if (!current) return
    current.child.kill("SIGKILL")
    await current.child.exited
    await current.reader.return?.()
    await current.errors
    current = undefined
  })
  const request = (input: LogRequest) => testStage(`log lifecycle ${input.type}`, async () => {
    assert.ok(current)
    current.child.stdin.write(`${JSON.stringify(input)}\n`)
    await current.child.stdin.flush()
    return next()
  })
  const result = async <Value>(input: LogRequest): Promise<Value> => {
    const response = await request(input)
    assert.equal(response.type, "result")
    assert.ok("value" in response)
    return response.value as Value
  }
  let descriptionId = 0
  try { await launch() } catch (error) { await kill(); await rm(directory, { recursive: true, force: true }); throw error }
  return {
    record: async (thread, fact, id) => { await result({ type: "record", thread, fact, id }) },
    describe: (thread, type) => result({ type: "recall", thread, id: `describe-${descriptionId++}`, method: "describe", input: type === undefined ? {} : { type } }),
    query: (thread, sql, id, through) => result({ type: "recall", thread, id, method: "query", input: { sql, ...(through === undefined ? {} : { through }) } }),
    search: (thread, query, id, options) => result({ type: "recall", thread, id, method: "search", input: { query, ...options } }),
    loseReply: async (thread, sql, id) => {
      const response = await request({ type: "recall", thread, id, method: "query", input: { sql }, loseReply: true })
      assert.equal(response.type, "boundary")
      assert.ok("status" in response)
      return response.status
    },
    status: thread => result({ type: "status", thread }),
    restart: async () => { await kill(); await launch() },
    close: async () => { try { await kill() } finally { await rm(directory, { recursive: true, force: true }) } },
  }
}
