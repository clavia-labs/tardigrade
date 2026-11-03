import { AwsClient } from "aws4fetch"
import { Effect } from "effect"
import { ObjectStorage, type ObjectRef } from "@clavia/tardigrade-store"
import { createWorkspaceObject, r2Mount, type R2MountOptions } from "../../../../src/cloudflare/workspace"
import { objectStorageFromR2 } from "@clavia/tardigrade-cloudflare/object-storage/r2"
import type { LifecycleRequest } from "../shared"
export { S3Gateway } from "../../../../src/cloudflare/workspace"
export { WorkspaceNetworkProxy } from "../../../../src/cloudflare/workspace-network"

interface HeavyEnv {
  readonly WORKSPACES: DurableObjectNamespace<HeavyWorkspace>
  readonly FILES: R2Bucket
  readonly OBJECTS: R2Bucket
  readonly FIXTURE_ORIGIN: string
}
const credentials = { accessKeyId: "fixture", secretAccessKey: "fixture-secret" }
const content = (ctx: DurableObjectState, env: HeavyEnv) => objectStorageFromR2(env.OBJECTS, { prefix: `objects/${ctx.id}/` })
const execute = async (container: Container, command: string[], signal?: AbortSignal) => {
  const child = await container.exec(command, { stdout: "pipe", stderr: "pipe", ...(signal ? { signal } : {}) })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exitCode])
  if (code !== 0) throw new Error(`Container command failed (${code}): ${stderr || stdout}`)
  return stdout
}
const Base = createWorkspaceObject<HeavyEnv>({
  directory: "/workspace", network: { mode: "allowlist", hosts: ["allowed.workspace.test"] }, idempotency: true, release: "retain",
  contentStore: content,
  start: (_env, container) => ({ image: container.images.workspace! }),
  mounts: (container, ctx, env) => {
    const gateway = (ctx.exports as { S3Gateway: R2MountOptions["gateway"] }).S3Gateway
    const common = { container, gateway, endpoint: env.FIXTURE_ORIGIN, bucket: "workspace-files", credentials: { type: "static" as const, ...credentials } }
    return [
      r2Mount({ ...common, directory: "/workspace/inputs", prefix: "inputs/", access: "read-only", flush: async () => {} }),
      r2Mount({ ...common, directory: "/workspace/output", prefix: `outputs/${ctx.id}/`, flush: signal => execute(container, ["python3", "/usr/local/bin/workspace-flush", "/workspace/output"], signal).then(() => {}) }),
    ]
  },
})

export class HeavyWorkspace extends Base {
  private readonly incarnation = crypto.randomUUID()
  private reached = false
  async identity() { return { host: this.incarnation, container: await execute(this.ctx.container!, ["sh", "-c", "while [ ! -f /tmp/workspace-ready ]; do sleep 0.1; done; cat /tmp/workspace-incarnation"]) } }
  boundary() { return this.reached }
  reset() { this.ctx.abort("Heavy workspace restart") }
  async loseReply(command: string, key: string): Promise<never> {
    await this.bash(command, { idempotencyKey: key })
    await this.ctx.storage.sync()
    this.reached = true
    return new Promise<never>(() => {})
  }
  replaceContainer() { return this.ctx.container!.destroy() }
  resolve(object: ObjectRef) { return Effect.runPromise(Effect.flatMap(ObjectStorage, store => store.get(object)).pipe(Effect.provide(content(this.ctx, this.env)))) }
  async stored() {
    const file = await this.env.FILES.get(`outputs/${this.ctx.id}/artifact.png`)
    return file ? Array.from(new Uint8Array(await file.arrayBuffer())) : null
  }
}

export default {
  async fetch(request: Request, env: HeavyEnv): Promise<Response> {
    const url = new URL(request.url)
    // Identity encoding preserves the byte ranges expected by s3fs.
    if (url.pathname === "/workspace-files" || url.pathname.startsWith("/workspace-files/")) {
      const headers = new Headers(request.headers)
      for (const name of ["authorization", "host", "x-amz-date", "x-amz-content-sha256", "accept-encoding"]) headers.delete(name)
      const signer = new AwsClient({ ...credentials, service: "s3", region: "auto" })
      const signed = await signer.sign(`${env.FIXTURE_ORIGIN}/cdn-cgi/local/r2/s3${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, redirect: "manual" })
      signed.headers.set("accept-encoding", "identity")
      const response = await fetch(signed)
      const responseHeaders = new Headers(response.headers)
      responseHeaders.set("content-encoding", "identity")
      responseHeaders.set("cache-control", "no-transform")
      return new Response(response.body, { status: response.status, headers: responseHeaders, encodeBody: "manual" })
    }
    if (url.pathname === "/seed") { await env.FILES.put("inputs/instructions.txt", "Read-only instructions\n"); return new Response("seeded") }
    const stub = env.WORKSPACES.getByName("lifecycle")
    try {
      if (url.pathname === "/identity") return Response.json(await stub.identity())
      if (url.pathname === "/boundary") return Response.json(await stub.boundary())
      if (url.pathname === "/reset") {
        try { await stub.reset(); throw new Error("Expected host abort") } catch (error) { if (!String(error).includes("Heavy workspace restart")) throw error }
        return new Response("restarted")
      }
      if (url.pathname === "/replace" || url.pathname === "/destroy") { await stub.replaceContainer(); return new Response("stopped") }
      if (url.pathname === "/stored") return Response.json(await stub.stored())
      const input = await request.json() as LifecycleRequest
      switch (input.type) {
        case "bash": return Response.json(input.loseReply ? await stub.loseReply(input.command, input.key) : await stub.bash(input.command, { idempotencyKey: input.key }))
        case "read": return Response.json(await stub.read(input.path))
        case "resolve": return Response.json(Array.from(await stub.resolve(input.object)))
      }
    } catch (error) { return Response.json({ error: String(error) }, { status: 500 }) }
  },
}
