import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { Effect, ManagedRuntime } from "effect"
import { FilesystemWorkspace } from "@clavia/tardigrade-libraries/filesystem/index"
import { remoteWorkspace } from "../../../src/shared/workspace/remote"
import type { WorkspaceIdempotencyDO } from "./workspace-idempotency.worker"
import type { Outcome, Request, Response } from "../workspace-idempotency-protocol"
import { DEFAULT_WAIT_POLICY, testStage } from "../wait"
import { workspaceMutation, workspaceMutationFailure } from "../workspace-idempotency"

const namespace = (env as unknown as { WORKSPACE_IDEMPOTENCY: DurableObjectNamespace<WorkspaceIdempotencyDO> }).WORKSPACE_IDEMPOTENCY

// cloudflareWorkspaceIdempotency supplies native DO RPC and SQLite to the shared workspace properties.
export async function cloudflareWorkspaceIdempotency() {
  const name = crypto.randomUUID()
  const freshStubs = () => [0, 1].map(workspace => namespace.getByName(`${name}:${workspace}`))
  let stubs = freshStubs()
  const incarnations = await Promise.all(stubs.map((stub, workspace) => stub.configure(workspace, "none")))
  const abort = async (stub: typeof stubs[number]) => {
    try { await stub.reset(); assert.fail("Expected Durable Object abort") } catch (error) {
      assert.match(String(error), /Workspace idempotency restart/)
    }
  }
  const request = async (input: Request): Promise<Response> => {
    if (input.type === "snapshot") {
      const snapshots = await Promise.all(stubs.map(stub => stub.snapshot()))
      return { type: "snapshot", snapshot: {
        rows: snapshots.flatMap(snapshot => snapshot.rows), logs: snapshots.map(snapshot => snapshot.log),
        files: snapshots.map(snapshot => snapshot.file), outside: snapshots.find(snapshot => snapshot.outside !== null)?.outside ?? null,
      } }
    }
    const stub = stubs[input.workspace]!
    incarnations[input.workspace] = await stub.configure(input.workspace, input.fault)
    const runtime = ManagedRuntime.make(remoteWorkspace(stub))
    try {
      let settled = false
      const pending = Promise.all(Array.from({ length: input.copies }, async (): Promise<Outcome> => {
        try {
          return await runtime.runPromise(Effect.gen(function* () {
            const workspace = yield* FilesystemWorkspace
            assert.ok(workspace.idempotency)
            return yield* workspaceMutation(workspace, input)
          }))
        } catch (error) { return workspaceMutationFailure(error) }
      })).then(outcomes => { settled = true; return outcomes })
      if (input.fault !== "none" && input.fault !== "claimFailure") {
        while (!settled) {
          const control = namespace.getByName(`${name}:${input.workspace}`)
          const boundary = await control.boundary()
          if (boundary !== null) {
            await abort(control)
            const outcomes = await pending
            return { type: "boundary", fault: boundary, outcomes }
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([pending, new Promise<void>(resolve => { timer = setTimeout(resolve, DEFAULT_WAIT_POLICY.pollIntervalMs) })])
          } finally { if (timer !== undefined) clearTimeout(timer) }
        }
      }
      return { type: "result", outcomes: await pending }
    } finally { await runtime.dispose() }
  }
  return {
    request: (input: Request) => testStage(`Cloudflare workspace ${JSON.stringify(input)}`, () => request(input)),
    restart: () => testStage("restarting workspace objects", async () => {
      stubs = freshStubs()
      await Promise.all(stubs.map(abort))
      stubs = freshStubs()
      for (const [workspace, stub] of stubs.entries()) {
        const incarnation = await stub.instance()
        assert.notEqual(incarnation, incarnations[workspace])
        incarnations[workspace] = incarnation
      }
    }),
    close: () => testStage("closing workspace objects", async () => {
      await Promise.all(freshStubs().map(abort))
    }),
  }
}
