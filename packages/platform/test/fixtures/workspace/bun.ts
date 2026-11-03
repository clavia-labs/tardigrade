import { strict as assert } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { createInterface } from "node:readline"
import { Readable } from "node:stream"
import { join } from "node:path"
import { testStage } from "../wait"
import type { WorkspaceScenarioRequest, LifecycleResponse, WorkspaceScenarioDriver, WorkspaceCrashPoint } from "./shared"

// bunWorkspaceLifecycle hosts the workspace and SQLite content store in a killable subprocess.
export async function bunWorkspaceLifecycle(): Promise<WorkspaceScenarioDriver> {
  const directory = await mkdtemp(join(tmpdir(), "tardie-workspace-lifecycle-"))
  const start = () => {
    const child = Bun.spawn([process.execPath, new URL("./bun-process.ts", import.meta.url).pathname, directory], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    return { child, reader: createInterface({ input: Readable.fromWeb(child.stdout) })[Symbol.asyncIterator](), errors: new Response(child.stderr).text() }
  }
  let processState: ReturnType<typeof start> | undefined
  const next = async (): Promise<LifecycleResponse> => {
    assert.ok(processState)
    const line = await processState.reader.next()
    if (line.done) throw new Error(`Workspace process exited: ${await processState.errors}`)
    const value = JSON.parse(line.value) as LifecycleResponse
    if (value.type === "error") throw new Error(value.message)
    return value
  }
  const launch = () => testStage("starting workspace lifecycle process", async () => {
    processState = start()
    assert.equal((await next()).type, "ready")
  })
  const kill = () => testStage("stopping workspace lifecycle process", async () => {
    if (!processState) return
    processState.child.kill("SIGKILL")
    await processState.child.exited
    await processState.reader.return?.()
    await processState.errors
    processState = undefined
  })
  const request = (input: WorkspaceScenarioRequest) => testStage(`workspace lifecycle ${input.type}`, async () => {
    assert.ok(processState)
    processState.child.stdin.write(`${JSON.stringify(input)}\n`)
    await processState.child.stdin.flush()
    return next()
  })
  const result = async <Value>(input: WorkspaceScenarioRequest): Promise<Value> => {
    const response = await request(input)
    assert.equal(response.type, "result")
    assert.ok("value" in response)
    return response.value as Value
  }
  const interrupt = async (command: string, key: string, fault: WorkspaceCrashPoint) => {
    assert.equal((await request({ type: "bash", command, key, fault })).type, "boundary")
  }
  try { await launch() } catch (error) { await kill(); await rm(directory, { recursive: true, force: true }); throw error }
  return {
    bash: (command, key) => result({ type: "bash", command, key }),
    read: path => result({ type: "read", path }),
    resolve: async object => new Uint8Array(await result<number[]>({ type: "resolve", object })),
    write: async (path, content, key) => { await result({ type: "write", path, content, key }) },
    edit: async (path, oldText, newText, key) => { await result({ type: "edit", path, oldText, newText, key }) },
    interrupt,
    loseReply: (command, key) => interrupt(command, key, "afterComplete"),
    restart: async () => { await kill(); await launch() },
    close: async () => { try { await kill() } finally { await rm(directory, { recursive: true, force: true }) } },
  }
}
