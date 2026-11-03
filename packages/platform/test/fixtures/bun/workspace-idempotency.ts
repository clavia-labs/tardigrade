import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { join } from "node:path"
import type { Request, Response } from "../workspace-idempotency-protocol"
import { testStage } from "../wait"

// bunWorkspaceIdempotency runs filesystem mutations in a killable process with persistent SQLite.
export async function bunWorkspaceIdempotency() {
  const directory = mkdtempSync(join(tmpdir(), "tardie-workspace-idempotency-"))
  const start = () => {
    const childProcess = Bun.spawn([process.execPath, new URL("./workspace-idempotency-process.ts", import.meta.url).pathname, directory], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    return { process: childProcess, reader: createInterface({ input: Readable.fromWeb(childProcess.stdout) })[Symbol.asyncIterator](), errors: new Response(childProcess.stderr).text() }
  }
  let child: ReturnType<typeof start> | undefined
  const next = async (): Promise<Response> => {
    assert.ok(child)
    const line = await child.reader.next()
    if (line.done) throw new Error(`Workspace child exited: ${await child.errors}`)
    const value = JSON.parse(line.value) as Response
    if (value.type === "fatal") throw new Error(value.message)
    return value
  }
  const launch = async () => {
    child = start()
    assert.equal((await testStage("starting workspace child", next)).type, "ready")
  }
  const kill = async () => {
    if (!child) return
    child.process.kill("SIGKILL")
    await child.process.exited
    await child.reader.return?.()
    await child.errors
    child = undefined
  }
  try { await launch() } catch (error) {
    await kill()
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    request: (request: Request) => testStage(`workspace ${request.type}`, async () => {
      assert.ok(child)
      child.process.stdin.write(`${JSON.stringify(request)}\n`)
      await child.process.stdin.flush()
      return next()
    }),
    restart: async () => { await kill(); await launch() },
    close: async () => { await kill(); rmSync(directory, { recursive: true, force: true }) },
  }
}
