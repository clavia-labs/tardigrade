import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { afterAll, test } from "bun:test"
import { Effect } from "effect"
import { BOXD_LIVE_TIMEOUT_MS, findComputer, liveBoxd, liveName, removeComputer, withLiveWorkspace } from "../../fixtures/workspace/boxd-live"

const { client, org } = liveBoxd()
const names: string[] = []
const named = (label: string) => { const name = liveName(label); names.push(name); return name }
const run = <A>(effect: Effect.Effect<A, Error>) => Effect.runPromise(effect)
const base = { client, ...(org ? { org } : {}) }

afterAll(async () => {
  try { for (const name of names) await removeComputer(client, org, name) } finally { client.close() }
})

test("network none leaves the computer without DNS or egress", async () => {
  const output = await withLiveWorkspace({ ...base, name: named("none") }, workspace => run(workspace.bash("getent hosts example.com >/dev/null && echo resolved || echo no-dns; curl -sS -m 5 -o /dev/null https://example.com && echo reached || echo blocked")))
  assert.equal(output.split("\n").filter(line => !line.startsWith("curl:")).join("\n").trim(), "no-dns\nblocked")
}, BOXD_LIVE_TIMEOUT_MS)

test("an allowlist admits its hosts and nothing else", async () => {
  const output = await withLiveWorkspace({ ...base, name: named("allowlist"), network: { mode: "allowlist", hosts: ["example.com"] } }, workspace => run(workspace.bash("curl -sS -m 10 -o /dev/null -w 'example %{http_code}\\n' https://example.com; curl -sS -m 10 -o /dev/null https://api.github.com 2>/dev/null && echo github reached || echo github blocked")))
  assert.equal(output.trim(), "example 200\ngithub blocked")
}, BOXD_LIVE_TIMEOUT_MS)

test("network all reaches the internet", async () => {
  const output = await withLiveWorkspace({ ...base, name: named("all"), network: { mode: "all" } }, workspace => run(workspace.bash("curl -sS -m 10 -o /dev/null -w '%{http_code}' https://api.github.com")))
  assert.equal(output, "200")
}, BOXD_LIVE_TIMEOUT_MS)

test("retain hibernates the computer and the next host finds its files and processes", async () => {
  const name = named("retain")
  const pid = await withLiveWorkspace({ ...base, name, release: "retain" }, async workspace => {
    await run(workspace.write("notes/plan.md", "step one\n"))
    return (await run(workspace.bash("nohup sleep 600 >/dev/null 2>&1 & echo $!"))).trim()
  })
  const retained = await findComputer(client, org, name)
  assert.ok(retained && ["hibernated", "suspended"].includes(retained.status), `retained computer is ${retained?.status}`)
  const after = await withLiveWorkspace({ ...base, name, release: "destroy" }, async workspace => [await run(workspace.read("notes/plan.md")), await run(workspace.bash("cat notes/plan.md | wc -l")), await run(workspace.bash(`kill -0 ${pid} && echo alive`))])
  assert.deepEqual(after, ["step one\n", "1\n", "alive\n"])
  assert.equal(await findComputer(client, org, name), undefined)
}, BOXD_LIVE_TIMEOUT_MS)

test("a command timeout stops the remote process", async () => {
  await withLiveWorkspace({ ...base, name: named("timeout"), policy: { commandTimeoutMs: 2_000 } }, async workspace => {
    await assert.rejects(run(workspace.bash("sleep 6; touch late.txt")), /timed out after 2000ms/)
    await new Promise(resolve => setTimeout(resolve, 6_000))
    assert.equal(await run(workspace.bash("test -e late.txt && echo present || echo absent")), "absent\n")
  })
}, BOXD_LIVE_TIMEOUT_MS)

test("a stopped computer is started by the next command", async () => {
  const name = named("stopped")
  await withLiveWorkspace({ ...base, name }, async workspace => {
    await run(workspace.write("kept.txt", "kept\n"))
    const computer = await findComputer(client, org, name)
    assert.ok(computer)
    await client.machines.stop(computer.id, computer.region ? { region: computer.region } : {})
    assert.equal(await run(workspace.bash("cat kept.txt")), "kept\n")
  })
}, BOXD_LIVE_TIMEOUT_MS)

test("a 5 MiB file round trips byte for byte", async () => {
  const content = Array.from({ length: 5 * 1024 * 1024 / 64 }, (_, index) => `${index.toString(16).padStart(8, "0")}${"x".repeat(55)}\n`).join("")
  const digest = createHash("sha256").update(content).digest("hex")
  await withLiveWorkspace({ ...base, name: named("large"), policy: { maxReadChars: 6 * 1024 * 1024, maxOutputChars: 6 * 1024 * 1024 } }, async workspace => {
    await run(workspace.write("large.txt", content))
    assert.equal(await run(workspace.bash("sha256sum large.txt | cut -d' ' -f1; wc -c < large.txt")), `${digest}\n${content.length}\n`)
    assert.equal(createHash("sha256").update(String(await run(workspace.read("large.txt")))).digest("hex"), digest)
  })
}, BOXD_LIVE_TIMEOUT_MS)

test("a named region holds the computer and every call reaches it", async () => {
  const name = named("region")
  const output = await withLiveWorkspace({ ...base, name, region: "nyc", release: "unmount" }, async workspace => {
    await run(workspace.write("region.txt", "nyc\n"))
    return run(workspace.bash("cat region.txt"))
  })
  assert.equal(output, "nyc\n")
  assert.equal((await findComputer(client, org, name))?.region, "nyc")
}, BOXD_LIVE_TIMEOUT_MS)
