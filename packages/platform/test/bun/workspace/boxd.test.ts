import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { Effect, Fiber, ManagedRuntime } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { FilesystemWorkspace, type FilesystemWorkspaceService } from "@clavia/tardigrade-libraries/filesystem/index"
import { boxdEgress, boxdWorkspace, boxdWorkspaceId, boxdWorkspaceName, DEFAULT_BOXD_WORKSPACE_DIRECTORY, DEFAULT_BOXD_WORKSPACE_NAME_PREFIX, type BoxdWorkspaceOptions } from "../../../src/boxd/workspace"
import { sqlIdempotencyStore } from "../../../src/shared/workspace/idempotency-store"
import { fakeBoxd, type FakeExec } from "../../fixtures/workspace/boxd"
import { waitFor } from "../../fixtures/wait"

const shell = (handler: (script: string) => ReturnType<FakeExec>): FakeExec => command => command[0] === "true" ? {} : handler(command[2] ?? "")

async function withWorkspace<A>(options: Omit<BoxdWorkspaceOptions, "client"> & { readonly fake: ReturnType<typeof fakeBoxd> }, run: (workspace: FilesystemWorkspaceService) => Promise<A>): Promise<A> {
  const { fake, ...rest } = options
  const runtime = ManagedRuntime.make(boxdWorkspace({ ...rest, client: fake.client }))
  try { return await run(await runtime.runPromise(Effect.map(FilesystemWorkspace, workspace => workspace))) } finally { await runtime.dispose() }
}
const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)
const created = (fake: ReturnType<typeof fakeBoxd>) => (fake.calls.find(call => call.method === "create")?.detail as { readonly spec?: unknown } | undefined)?.spec
const statuses = (fake: ReturnType<typeof fakeBoxd>) => [...fake.computers.values()].map(computer => computer.status)
const called = (fake: ReturnType<typeof fakeBoxd>, method: string) => waitFor(async () => fake.methods(), methods => methods.includes(method))

test("network policies map onto boxd egress allowlists", () => {
  assert.deepEqual(boxdEgress(), ["none"])
  assert.deepEqual(boxdEgress({ mode: "none" }), ["none"])
  assert.deepEqual(boxdEgress({ mode: "all" }), [])
  assert.deepEqual(boxdEgress({ mode: "allowlist", hosts: ["Registry.NPMjs.org.", "example.com"] }), ["example.com", "registry.npmjs.org"])
  assert.throws(() => boxdEgress({ mode: "allowlist", hosts: ["*.example.com"] }), /without wildcards/)
})

test("computer names follow the whole thread coordinate", () => {
  const root = { actor: "agent", instance: "main", thread: "root" }
  assert.match(boxdWorkspaceName(root), new RegExp(`^${DEFAULT_BOXD_WORKSPACE_NAME_PREFIX}[0-9a-f]{16}$`))
  assert.equal(boxdWorkspaceName(root), boxdWorkspaceName({ ...root }))
  assert.notEqual(boxdWorkspaceName(root), boxdWorkspaceName({ ...root, instance: "other" }))
  assert.notEqual(boxdWorkspaceName(root), boxdWorkspaceName({ ...root, actor: "researcher" }))
  assert.match(boxdWorkspaceName(root, "acme-"), /^acme-[0-9a-f]{16}$/)
})

test("new computers are isolated and carry the egress, size, snapshot, and labels", async () => {
  const open = fakeBoxd()
  await withWorkspace({ fake: open, name: "agent-1", network: { mode: "all" } }, workspace => run(workspace.bash("true")))
  assert.deepEqual(created(open), { version: 1, isolated: true })
  const golden = fakeBoxd()
  await withWorkspace({ fake: golden, name: "agent-1", size: "4x16", snapshot: "golden", labels: { app: "tardie" }, network: { mode: "allowlist", hosts: ["example.com"] } }, workspace => run(workspace.bash("true")))
  assert.deepEqual(created(golden), { version: 1, isolated: true, egress: ["example.com"], size: "4x16", base: { snapshot: "golden" }, labels: { app: "tardie" } })
})

test("bash creates one named computer and runs in the workspace directory", async () => {
  const cwds: Array<string | undefined> = []
  const fake = fakeBoxd((command, _computer, cwd) => { cwds.push(cwd); return command[0] === "true" ? {} : { stdout: "out\n", stderr: "err\n", code: 3 } })
  const output = await withWorkspace({ fake, name: "agent-1", org: "acme", region: "nyc" }, workspace => run(workspace.bash("make test")))
  assert.equal(output, "out\nerr\n\nexit code 3")
  const create = fake.calls.find(call => call.method === "create")
  assert.deepEqual(create?.detail, { name: "agent-1", org: "acme", region: "nyc", spec: { version: 1, isolated: true, egress: ["none"] } })
  assert.ok(fake.calls.filter(call => call.id).every(call => call.region === "nyc"), "every call after create addresses the computer's region")
  assert.equal(cwds.at(-1), DEFAULT_BOXD_WORKSPACE_DIRECTORY)
  assert.deepEqual(fake.methods().filter(method => method === "create"), ["create"])
})

test("startup waits use the policy's timeout and poll interval", async () => {
  const fake = fakeBoxd()
  await withWorkspace({ fake, name: "agent-1", policy: { startupTimeoutMs: 5_000, startupPollIntervalMs: 40 } }, workspace => run(workspace.bash("true")))
  assert.deepEqual(fake.calls.find(call => call.method === "waitUntilReady")?.detail, { region: "fra", timeout: 5_000, pollInterval: 40 })
})

test("a restarted host adopts the computer with the same name", async () => {
  const fake = fakeBoxd()
  const existing = fake.add({ name: "agent-1", region: "nyc", status: "hibernated", egress: ["none"] })
  existing.files.set("/home/boxd/workspace/notes.txt", new TextEncoder().encode("kept\n"))
  const text = await withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.read("notes.txt")))
  assert.equal(text, "kept\n")
  assert.ok(!fake.methods().includes("create"))
  assert.equal((fake.calls.find(call => call.method === "list")?.detail as { readonly region?: string } | undefined)?.region, "all")
  assert.equal(fake.calls.find(call => call.method === "fs.readStream")?.region, "nyc")
})

test("adoption refuses a computer whose isolation or egress differs and leaves it in place", async () => {
  const open = fakeBoxd()
  open.add({ name: "agent-1", egress: [] })
  await assert.rejects(withWorkspace({ fake: open, name: "agent-1" }, workspace => run(workspace.bash("true"))), /Workspace network policy is fixed at creation/)
  const shared = fakeBoxd()
  shared.add({ name: "agent-1", egress: ["none"], isolated: false })
  await assert.rejects(withWorkspace({ fake: shared, name: "agent-1" }, workspace => run(workspace.bash("true"))), /is not isolated/)
  assert.deepEqual([...statuses(open), ...statuses(shared)], ["running", "running"])
  assert.ok(![...open.methods(), ...shared.methods()].includes("delete"))
})

test("adoption refuses a name held in two regions until a region is chosen", async () => {
  const fake = fakeBoxd()
  fake.add({ name: "agent-1", region: "fra", egress: ["none"] })
  const nyc = fake.add({ name: "agent-1", region: "nyc", egress: ["none"] })
  nyc.files.set("/home/boxd/workspace/where", new TextEncoder().encode("nyc"))
  await assert.rejects(withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.bash("true"))), /exists in regions fra and nyc; set region to choose one/)
  assert.equal(await withWorkspace({ fake, name: "agent-1", region: "nyc", release: "retain", retained: "running" }, workspace => run(workspace.read("where"))), "nyc")
  assert.ok(!fake.methods().includes("create"))
  assert.deepEqual(statuses(fake), ["running", "running"])
})

test("a region that does not answer stops adoption from creating a second computer", async () => {
  const fake = fakeBoxd()
  fake.add({ name: "agent-1", region: "nyc", egress: ["none"] })
  fake.unavailable.push("nyc")
  await assert.rejects(withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.bash("true"))), /Regions nyc did not answer and may hold computer agent-1/)
  fake.unavailable.length = 0
  assert.equal(await withWorkspace({ fake, name: "agent-1", release: "retain", retained: "running" }, workspace => run(workspace.bash("echo back"))), "ran sh -c echo back\n")
  assert.ok(!fake.methods().includes("create"))
})

test("a stopped computer is started and the command runs once", async () => {
  let runs = 0
  const fake = fakeBoxd(shell(() => { runs++; return { stdout: "done\n" } }))
  const computer = fake.add({ name: "agent-1", egress: ["none"] })
  await withWorkspace({ fake, name: "agent-1" }, async workspace => {
    await run(workspace.write("a.txt", "a"))
    computer.status = "stopped"
    assert.equal(await run(workspace.bash("work")), "done\n")
  })
  assert.equal(runs, 1)
  assert.deepEqual(fake.methods().filter(method => method === "start"), ["start"])
})

test("a command that times out while a stopped computer starts never runs", async () => {
  const scripts: string[] = []
  const fake = fakeBoxd(shell(script => { scripts.push(script); return {} }))
  const computer = fake.add({ name: "agent-1", egress: ["none"] })
  const started = Promise.withResolvers<void>()
  await withWorkspace({ fake, name: "agent-1", policy: { commandTimeoutMs: 50 } }, async workspace => {
    await run(workspace.bash("first"))
    computer.status = "stopped"
    fake.before.start = () => started.promise
    await assert.rejects(run(workspace.bash("touch late.txt")), /timed out after 50ms/)
    started.resolve()
    await called(fake, "waitUntilReady")
    await new Promise(resolve => setTimeout(resolve, 10))
  })
  assert.deepEqual(scripts, ["first"])
})

test("a command whose stream never settles still times out", async () => {
  const fake = fakeBoxd(shell(() => ({ hang: true })))
  await withWorkspace({ fake, name: "agent-1", policy: { commandTimeoutMs: 50 } }, workspace => assert.rejects(run(workspace.bash("sleep 600")), /timed out after 50ms/))
})

test("write, read, and edit go through the computer filesystem", async () => {
  const fake = fakeBoxd()
  await withWorkspace({ fake, name: "agent-1" }, async workspace => {
    await run(workspace.write("src/app.txt", "const value = 1\n"))
    await run(workspace.edit("src/app.txt", "1", "2"))
    assert.equal(await run(workspace.read("src/app.txt")), "const value = 2\n")
    await assert.rejects(run(workspace.read("missing.txt")), /No such file or directory/)
    await assert.rejects(run(workspace.write("../outside.txt", "x")), /outside the workspace directory/)
  })
  const computer = [...fake.computers.values()][0]!
  assert.equal(new TextDecoder().decode(computer.files.get("/home/boxd/workspace/src/app.txt")), "const value = 2\n")
  assert.ok(fake.calls.some(call => call.method === "fs.mkdir" && call.detail === "/home/boxd/workspace/src"))
})

test("release destroy deletes the computer", async () => {
  const fake = fakeBoxd()
  await withWorkspace({ fake, name: "agent-1" }, workspace => run(workspace.bash("true")))
  assert.deepEqual(statuses(fake), ["destroyed"])
})

test("release retain hibernates the computer unless it is kept running", async () => {
  const hibernated = fakeBoxd()
  await withWorkspace({ fake: hibernated, name: "agent-1", release: "retain" }, workspace => run(workspace.bash("true")))
  assert.deepEqual(statuses(hibernated), ["hibernated"])
  const running = fakeBoxd()
  await withWorkspace({ fake: running, name: "agent-1", release: "retain", retained: "running" }, workspace => run(workspace.bash("true")))
  assert.deepEqual(statuses(running), ["running"])
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

test("a deleted computer fails the command and the next operation creates a new one", async () => {
  const fake = fakeBoxd()
  await withWorkspace({ fake, name: "agent-1" }, async workspace => {
    await run(workspace.bash("true"))
    for (const computer of fake.computers.values()) computer.status = "destroyed"
    await assert.rejects(run(workspace.bash("echo lost")), /ended without an exit status/)
    assert.equal(await run(workspace.bash("echo again")), "ran sh -c echo again\n")
  })
  assert.deepEqual(fake.methods().filter(method => method === "create"), ["create", "create"])
})

test("keyed mutations replay from the store under the computer's identity", async () => {
  const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: ":memory:" }))
  try {
    const store = await runtime.runPromise(sqlIdempotencyStore)
    let runs = 0
    const fake = fakeBoxd(shell(() => { runs++; return { stdout: `run ${runs}\n` } }))
    const options = { fake, name: "agent-1", org: "acme", idempotency: store, release: "retain" as const }
    const first = await withWorkspace(options, workspace => {
      assert.deepEqual(workspace.idempotency, { workspaceId: boxdWorkspaceId({ org: "acme", name: "agent-1" }) })
      return run(workspace.bash("record", { idempotencyKey: "k" }))
    })
    const replayed = await withWorkspace(options, workspace => run(workspace.bash("record", { idempotencyKey: "k" })))
    assert.equal(first, "run 1\n")
    assert.equal(replayed, "run 1\n")
    assert.equal(runs, 1)
  } finally { await runtime.dispose() }
})

test("a computer name and a known release are required", async () => {
  await assert.rejects(withWorkspace({ fake: fakeBoxd(), name: " " }, workspace => run(workspace.bash("true"))), /requires a computer name/)
  await assert.rejects(withWorkspace({ fake: fakeBoxd(), name: "agent-1", release: "keep" as unknown as "retain" }, workspace => run(workspace.bash("true"))), /release must be destroy, retain, or unmount/)
})
