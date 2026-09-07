import { methodRequestLocation } from "@clavia/tardigrade-host/transport/http/method-request"
import type { ActorMethods } from "@clavia/tardigrade-core/actor/method"
import { Schema } from "effect"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { hostBackend, type Host } from "./create-host"

export const DEFAULT_HOST_IDLE_TIMEOUT_SECONDS = 10
export const DEFAULT_HOST_PORT = 4242
export const DEFAULT_HOST_HOSTNAME = "127.0.0.1"

export interface ServeOptions {
  readonly idleTimeoutSeconds?: number
  readonly port?: number
  readonly hostname?: string
  readonly token?: string
}

const allocationInput = Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString), key: Schema.optionalKey(Schema.NonEmptyString), parent: Schema.optionalKey(Schema.NonEmptyString) })

// serve exposes an existing Bun host through the actor HTTP protocol.
export const serve = <Methods extends ActorMethods>(host: Host<Methods>, options: ServeOptions = {}) => {
  const backend = hostBackend(host)
  const server = Bun.serve({
    port: options.port ?? DEFAULT_HOST_PORT,
    hostname: options.hostname ?? DEFAULT_HOST_HOSTNAME,
    idleTimeout: options.idleTimeoutSeconds ?? DEFAULT_HOST_IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      if (options.token !== undefined && request.headers.get("authorization") !== `Bearer ${options.token}`) return Response.json({ error: "unauthorized" }, { status: 401 })
      try {
        const url = new URL(request.url)
        const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
        if (request.method === "GET" && url.pathname === "/v1/metadata") return Response.json({ name: host.actor })
        if (parts[0] !== "v1" || parts[1] !== "actors" || !parts[2] || parts[3] !== "threads") return new Response(null, { status: 404 })
        const actor = url.searchParams.get("actor") ?? host.actor
        if (actor !== host.actor) throw new Error("target actor does not match this host")
        const instance = parts[2]
        if (request.method === "POST" && parts.length === 4) {
          const input = Schema.decodeUnknownSync(allocationInput)(await request.json())
          if (input.name !== undefined && input.key !== undefined) throw new Error("named allocations do not accept a separate key")
          const key = input.name === undefined ? { key: input.key ?? crypto.randomUUID() } : {}
          return Response.json(await backend.allocate(input.parent === undefined
            ? { kind: "root", coordinate: { actor, instance, thread: input.name ?? "" }, ...key }
            : { kind: "child", parent: { actor, instance, thread: input.parent }, child: childKeyOf(input.name ?? "unnamed"), ...key }))
        }
        const invocationPost = request.method === "POST" && parts.length === 7
        if ((!invocationPost && (parts.length !== 9 || parts[7] !== "calls")) || parts[5] !== "methods") return new Response(null, { status: 404 })
        const coordinate = { actor, instance, thread: parts[4]! }
        const method = parts[6]!, id = invocationPost ? request.headers.get("idempotency-key") : parts[8]!
        if (!id?.trim()) throw new Error("Idempotency-Key must be a nonempty header")
        if (invocationPost || request.method === "PUT") {
          const input: unknown = await request.json()
          const timeout = url.searchParams.get("timeoutMs")
          const receipt = await backend.submit(coordinate, method, input, { key: id, ...(timeout === null ? {} : { timeoutMs: Number(timeout) }), signal: request.signal })
          return Response.json(receipt, { status: 202, headers: { Location: methodRequestLocation(receipt.reference) } })
        }
        if (request.method === "GET") {
          const epoch = Number(url.searchParams.get("epoch") ?? 0)
          if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("invalid invocation epoch")
          const state = await backend.state({ target: coordinate, invocation: { method, id, epoch } })
          return state === undefined ? Response.json({ error: "unknown call" }, { status: 404 }) : Response.json(state)
        }
        return new Response(null, { status: 405 })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
      }
    }
  })
  return { url: server.url, port: server.port, close: () => server.stop() }
}
