import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { testStage, waitFor } from "../wait"
import type { WorkspaceLifecycleDO } from "./worker"
import type { WorkspaceScenarioDriver, WorkspaceCrashPoint } from "./shared"

const namespace = (env as unknown as { WORKSPACE_LIFECYCLE: DurableObjectNamespace<WorkspaceLifecycleDO> }).WORKSPACE_LIFECYCLE

// cloudflareWorkspaceLifecycle supplies a fresh Durable Object; the runner bounds cold startup (test/workerd/workspace/lifecycle.workers.ts).
export async function cloudflareWorkspaceLifecycle(): Promise<WorkspaceScenarioDriver> {
  const name = crypto.randomUUID()
  let stub = namespace.getByName(name)
  let incarnation = await stub.instance()
  let pending: Promise<{ readonly status: "returned" | "aborted" }> | undefined
  const abort = async () => {
    try { await namespace.getByName(name).reset(); assert.fail("Expected Durable Object abort") } catch (error) { assert.match(String(error), /Workspace lifecycle restart/) }
  }
  const interrupt = (command: string, key: string, fault: WorkspaceCrashPoint) => testStage(`waiting for ${fault}`, async () => {
    await stub.armFault(fault)
    pending = stub.bash(command, { idempotencyKey: key }).then(() => ({ status: "returned" as const }), () => ({ status: "aborted" as const }))
    await Promise.race([
      waitFor(() => namespace.getByName(name).boundary(), reached => reached),
      pending.then(() => { throw new Error(`Mutation ended before ${fault}`) }),
    ])
  })
  return {
    bash: (command, key) => testStage("workspace lifecycle bash", () => stub.bash(command, { idempotencyKey: key })),
    read: path => testStage("workspace lifecycle read", async () => await stub.read(path)),
    resolve: object => testStage("workspace lifecycle resolve", () => stub.resolve(object)),
    write: (path, content, key) => testStage("workspace lifecycle write", () => stub.write(path, content, { idempotencyKey: key })),
    edit: (path, oldText, newText, key) => testStage("workspace lifecycle edit", () => stub.edit(path, oldText, newText, { idempotencyKey: key })),
    interrupt,
    loseReply: (command, key) => interrupt(command, key, "afterComplete"),
    restart: () => testStage("restarting the workspace host", async () => {
      await abort()
      if (pending) assert.equal((await pending).status, "aborted")
      pending = undefined
      stub = namespace.getByName(name)
      const next = await stub.instance()
      assert.notEqual(next, incarnation)
      incarnation = next
    }),
    close: () => testStage("closing the workspace host", async () => { await abort(); if (pending) await pending }),
  }
}
