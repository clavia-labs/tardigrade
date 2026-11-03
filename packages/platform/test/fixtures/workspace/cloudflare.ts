import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { testStage, waitFor } from "../wait"
import type { WorkspaceLifecycleDO } from "./worker"
import type { WorkspaceLifecycleDriver } from "./shared"

const namespace = (env as unknown as { WORKSPACE_LIFECYCLE: DurableObjectNamespace<WorkspaceLifecycleDO> }).WORKSPACE_LIFECYCLE

// cloudflareWorkspaceLifecycle restarts a real Durable Object while its completed mutation waits to reply.
export async function cloudflareWorkspaceLifecycle(): Promise<WorkspaceLifecycleDriver> {
  const name = crypto.randomUUID()
  let stub = namespace.getByName(name)
  let incarnation = await stub.instance()
  let pending: Promise<{ readonly status: "returned" | "aborted" }> | undefined
  const abort = async () => {
    try { await namespace.getByName(name).reset(); assert.fail("Expected Durable Object abort") } catch (error) { assert.match(String(error), /Workspace lifecycle restart/) }
  }
  return {
    bash: (command, key) => testStage("workspace lifecycle bash", () => stub.bash(command, { idempotencyKey: key })),
    read: path => testStage("workspace lifecycle read", async () => await stub.read(path)),
    resolve: object => testStage("workspace lifecycle resolve", () => stub.resolve(object)),
    loseReply: (command, key) => testStage("waiting for the saved outcome before reply", async () => {
      await stub.armLostReply()
      pending = stub.bash(command, { idempotencyKey: key }).then(() => ({ status: "returned" as const }), () => ({ status: "aborted" as const }))
      await waitFor(() => namespace.getByName(name).boundary(), reached => reached)
    }),
    restart: () => testStage("restarting the workspace host", async () => {
      await abort()
      assert.ok(pending)
      assert.equal((await pending).status, "aborted")
      pending = undefined
      stub = namespace.getByName(name)
      const next = await stub.instance()
      assert.notEqual(next, incarnation)
      incarnation = next
    }),
    close: () => testStage("closing the workspace host", async () => { await abort(); if (pending) await pending }),
  }
}
