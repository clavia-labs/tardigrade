import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { FilesystemWorkspace, type FilesystemWorkspaceService } from "@clavia/tardigrade-libraries/filesystem/index"
import { boxdWorkspace, type BoxdWorkspaceOptions } from "../../../src/boxd/workspace"
import { fakeBoxd } from "../../fixtures/workspace/boxd"
import { waitFor } from "../../fixtures/wait"

async function withWorkspace<A>(options: Omit<BoxdWorkspaceOptions, "client"> & { readonly fake: ReturnType<typeof fakeBoxd> }, run: (workspace: FilesystemWorkspaceService) => Promise<A>): Promise<A> {
  const { fake, ...rest } = options
  const runtime = ManagedRuntime.make(boxdWorkspace({ ...rest, client: fake.client }))
  try { return await run(await runtime.runPromise(Effect.map(FilesystemWorkspace, workspace => workspace))) } finally { await runtime.dispose() }
}
const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)
const statuses = (fake: ReturnType<typeof fakeBoxd>) => [...fake.computers.values()].map(computer => computer.status)
const called = (fake: ReturnType<typeof fakeBoxd>, method: string) => waitFor(async () => fake.calls, calls => calls.includes(method))


test("adoption refuses a computer whose isolation or egress differs and leaves it in place", async () => {
  const open = fakeBoxd()
  open.add({ name: "agent-1", egress: [] })
  await assert.rejects(withWorkspace({ fake: open, name: "agent-1" }, workspace => run(workspace.bash("true"))), /Workspace network policy is fixed at creation/)
  const shared = fakeBoxd()
  shared.add({ name: "agent-1", egress: ["none"], isolated: false })
  await assert.rejects(withWorkspace({ fake: shared, name: "agent-1" }, workspace => run(workspace.bash("true"))), /is not isolated/)
  assert.deepEqual([...statuses(open), ...statuses(shared)], ["running", "running"])
  assert.ok(![...open.calls, ...shared.calls].includes("delete"))
})

test("a region that does not answer stops adoption from creating a second computer", async () => {
  for (const visibleMatch of [false, true]) {
    const fake = fakeBoxd()
    fake.add({ name: "agent-1", region: "nyc", egress: ["none"] })
    if (visibleMatch) fake.add({ name: "agent-1", region: "fra", egress: ["none"] })
    fake.unavailable.push("nyc")
    await assert.rejects(withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.bash("true"))), /Regions nyc did not answer and may hold computer agent-1/)
    assert.ok(!fake.calls.includes("create"))
    assert.ok(!fake.calls.includes("streamExec"))
  }
})

test("a command whose stream never settles still times out", async () => {
  const fake = fakeBoxd({ hangCommand: true })
  await withWorkspace({ fake, name: "agent-1", policy: { commandTimeoutMs: 50 } }, workspace => assert.rejects(run(workspace.bash("sleep 600")), /timed out after 50ms/))
  assert.ok(fake.calls.includes("close"))
})

test("release reaches a computer whose creation outlived an interrupted command", async () => {
  for (const [release, status] of [["destroy", "destroyed"], ["retain", "hibernated"]] as const) {
    const fake = fakeBoxd()
    const creation = Promise.withResolvers<void>()
    fake.before.create = () => creation.promise
    const runtime = ManagedRuntime.make(boxdWorkspace({ client: fake.client, name: "agent-1", release }))
    const workspace = await runtime.runPromise(Effect.map(FilesystemWorkspace, workspace => workspace))
    const command = runtime.runFork(workspace.bash("echo hi"))
    await called(fake, "create")
    await runtime.runPromise(Fiber.interrupt(command))
    const released = runtime.dispose()
    creation.resolve()
    await released
    assert.deepEqual(statuses(fake), [status], `release ${release}`)
  }
})

test("release destroy deletes a computer whose startup failed after create", async () => {
  const fake = fakeBoxd()
  fake.before.waitUntilReady = async () => { throw new Error("boot did not finish") }
  await assert.rejects(withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.bash("true"))), /boot did not finish/)
  assert.deepEqual(statuses(fake), ["destroyed"])
})
