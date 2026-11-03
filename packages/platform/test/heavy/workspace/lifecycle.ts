import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:net"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { unstable_startWorker } from "wrangler"
import { artifactBytes, type LifecycleRequest, type WorkspaceLifecycleDriver } from "../../fixtures/workspace/shared"
import { workspaceLifecycle } from "../../scenarios/workspace/lifecycle"
import { testStage, waitFor } from "../../fixtures/wait"

const timeoutMs = Number(process.env.WORKSPACE_HEAVY_TIMEOUT_MS ?? 180_000)
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "WORKSPACE_HEAVY_TIMEOUT_MS must be a positive safe integer")
const execute = promisify(execFile)
const docker = async (...args: string[]) => {
  try { return (await execute("docker", args)).stdout.trim() } catch (cause) {
    throw new Error("Docker is required; start Colima or Docker Desktop first", { cause })
  }
}
if (!process.env.DOCKER_HOST) process.env.DOCKER_HOST = await docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
await docker("info", "--format", "{{.ServerVersion}}")
const directory = await mkdtemp(join(tmpdir(), "tardie-workspace-heavy-"))
const probe = createServer()
await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve) })
const address = probe.address()
assert.ok(address && typeof address !== "string")
const port = address.port
await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
const origin = `http://127.0.0.1:${port}`
const fixture = fileURLToPath(new URL("../../fixtures/workspace/container/", import.meta.url))
const config = join(directory, "wrangler.json")
const name = `tdg-workspace-heavy-${crypto.randomUUID()}`
await writeFile(config, JSON.stringify({
  name, main: join(fixture, "worker.ts"),
  compatibility_date: "2026-10-06", compatibility_flags: ["nodejs_compat"],
  dev: { ip: "127.0.0.1", port },
  vars: { FIXTURE_ORIGIN: origin },
  containers: [{ class_name: "HeavyWorkspace", scheduling_policy: "durable_object", images: { workspace: { dockerfile: join(fixture, "Dockerfile"), build_context: fixture } } }],
  durable_objects: { bindings: [{ name: "WORKSPACES", class_name: "HeavyWorkspace" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["HeavyWorkspace"] }],
  r2_buckets: [
    { binding: "FILES", bucket_name: "workspace-files", local_dev: { experimental_s3_credentials: { accessKeyId: "fixture", secretAccessKey: "fixture-secret" } } },
    { binding: "OBJECTS", bucket_name: "workspace-objects" },
  ],
}))
const outboundService = async (request: Request) => {
  const url = new URL(request.url)
  if (url.hostname === "allowed.workspace.test" && url.pathname === "/health" && request.method === "GET") return new Response("allowed")
  if (url.origin === origin) return fetch(request.url, { method: request.method, headers: [...request.headers], body: request.body, duplex: "half" })
  return new Response("No fixture upstream route", { status: 403 })
}
const inOutput = (command: string) => `while [ ! -f /tmp/workspace-ready ]; do sleep 0.1; done; cd output; ${command}`
let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
try {
  worker = await unstable_startWorker({ config, dev: { logLevel: "warn", remote: false, containerBuildId: crypto.randomUUID(), persist: join(directory, "state"), outboundService } })
  await testStage("building and starting the native container fixture", () => worker!.ready, timeoutMs)
  console.log("Heavy workspace: native dev server ready")
  const request = async (path: string, input?: LifecycleRequest): Promise<Response> => {
    const response = await fetch(`${origin}${path}`, { method: input ? "POST" : "GET", ...(input ? { body: JSON.stringify(input), headers: { "content-type": "application/json" } } : {}), signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`Heavy fixture ${path}: ${response.status} ${await response.text()}`)
    return response
  }
  const result = async <Value>(input: LifecycleRequest): Promise<Value> => (await request("/call", input)).json() as Promise<Value>
  const identity = async () => (await request("/identity")).json() as Promise<{ host: string; container: string }>
  let pending: Promise<boolean> | undefined
  let replyFailure: unknown
  const driver: WorkspaceLifecycleDriver = {
    bash: (command, key) => result({ type: "bash", command: inOutput(command), key }),
    read: path => result({ type: "read", path: `output/${path}` }),
    resolve: async object => new Uint8Array(await result<number[]>({ type: "resolve", object })),
    loseReply: async (command, key) => {
      pending = request("/call", { type: "bash", command: inOutput(command), key, loseReply: true }).then(() => false, error => { replyFailure = error; return true })
      await waitFor(async () => {
        if (replyFailure) throw replyFailure
        return (await request("/boundary")).json() as Promise<boolean>
      }, value => value, { timeoutMs, pollIntervalMs: 100 })
    },
    restart: async () => {
      const before = await identity()
      await request("/reset")
      assert.ok(pending && await pending, "the original reply must be lost")
      pending = undefined
      replyFailure = undefined
      const after = await identity()
      assert.notEqual(after.host, before.host)
      assert.equal(after.container, before.container, "the host restart must retain the container")
    },
    close: async () => {
      try { if (pending) { await request("/reset"); await pending } } finally { await request("/destroy") }
    },
  }
  try {
    await request("/seed")
    await workspaceLifecycle(driver)
    assert.deepEqual(new Uint8Array(await (await request("/stored")).json() as number[]), artifactBytes, "acknowledged files must exist in local R2")
    assert.equal(await result({ type: "bash", command: "if sh -c 'printf changed > inputs/instructions.txt' 2>/dev/null; then printf unexpected; else printf readonly; fi", key: "readonly-inputs" }), "readonly")
    const readonly = await request("/call", { type: "read", path: "inputs/instructions.txt" })
    assert.equal(await readonly.json(), "Read-only instructions\n")
    assert.equal(await result({ type: "bash", command: "cmp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && printf trusted", key: "certificate-trust" }), "trusted")
    assert.equal(await result({ type: "bash", command: "curl -fsS --max-time 5 http://allowed.workspace.test/health; curl -fsS --max-time 5 https://allowed.workspace.test/health", key: "allowed-network" }), "allowedallowed")
    assert.equal(await result({ type: "bash", command: "if curl -sS --max-time 2 http://example.net >/dev/null 2>&1; then printf unexpected; else printf blocked; fi", key: "blocked-network" }), "blocked")
    await result({ type: "bash", command: "mkdir -p scratch; printf notes > scratch/notes.txt", key: "scratch" })
    const before = await identity()
    await request("/replace")
    assert.equal(await driver.read("changes.txt"), "recorded\n")
    const after = await identity()
    assert.notEqual(after.container, before.container, "replacement must create a fresh container")
    assert.equal(await result({ type: "bash", command: "test ! -e scratch/notes.txt && printf absent", key: "scratch-gone" }), "absent")
    const artifact = await driver.read("artifact.png")
    assert.ok(typeof artifact !== "string" && "object" in artifact)
    assert.deepEqual(await driver.resolve(artifact.object), artifactBytes)
    console.log("Heavy workspace lifecycle passed: native Docker, FUSE, local R2, host recovery, container replacement, and egress")
  } finally { await driver.close() }
} finally {
  try { await worker?.dispose() } finally {
    try {
      const containers = (await docker("ps", "-aq", "--filter", `name=workerd-${name}-`)).split("\n").filter(Boolean)
      if (containers.length) await docker("rm", "-f", ...containers)
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}
