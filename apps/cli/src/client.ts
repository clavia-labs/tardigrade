import { EventRow } from "@clavia/tardigrade-deprecated-client/contract"
import { Schema } from "effect"
import { makeActorClient, type ActorClient, type ActorClientOptions, type ActorCallRef, type MethodSummary } from "@clavia/tardigrade-deprecated-client"

export type CliClient = Pick<ActorClient, "baseUrl" | "allocateRoot" | "state" | "methodState" | "cancel" | "events"> & {
  readonly call: (actor: string, thread: string, method: string, call: { readonly id: string; readonly input: unknown; readonly timeoutMs?: number }) => Promise<ActorCallRef>
  readonly methods: () => Promise<readonly (Omit<MethodSummary, "timeoutMs"> & { readonly timeoutMs?: number })[]>
}

const Metadata = Schema.Struct({ name: Schema.String, api: Schema.optionalKey(Schema.String) })
const AtomState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("completed"), output: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("cancelled"), reason: Schema.String }),
])
const Methods = Schema.Array(Schema.Struct({ name: Schema.String, cancellable: Schema.Boolean, inputSchema: Schema.Unknown, outputSchema: Schema.Unknown }))

// openCliClient selects the mounted host protocol from its metadata and preserves legacy clients.
export function openCliClient(options: ActorClientOptions = {}, fetcher: typeof fetch = globalThis.fetch): CliClient {
  const legacy = makeActorClient(options)
  const request = async (path: string, init: Omit<RequestInit, "headers"> & { readonly headers?: Readonly<Record<string, string>> } = {}): Promise<unknown> => {
    const headers = new Headers(init.headers)
    if (options.token) headers.set("authorization", `Bearer ${options.token}`)
    if (init.body !== undefined) headers.set("content-type", "application/json")
    const response = await fetcher(`${legacy.baseUrl.replace(/\/$/, "")}${path}`, { ...init, headers })
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`)
    return value
  }
  let protocol: Promise<boolean> | undefined
  const modern = () => protocol ??= request("/v1/metadata").then(value => Schema.decodeUnknownSync(Metadata)(value).api === "atoms")
  const threadPath = (actor: string, thread: string) => `/v1/actors/${encodeURIComponent(actor)}/threads/${encodeURIComponent(thread)}`
  const state = async (ref: ActorCallRef) => {
    const value = Schema.decodeUnknownSync(AtomState)(await request(`${threadPath(ref.actor, ref.thread)}/methods/${encodeURIComponent(ref.method)}/calls/${encodeURIComponent(ref.id)}`))
    return value.status === "cancelled" ? { ...value, cause: "requested" as const } : value
  }
  return {
    baseUrl: legacy.baseUrl,
    allocateRoot: (actor, name) => legacy.allocateRoot(actor, name),
    methods: async () => await modern() ? Schema.decodeUnknownSync(Methods)(await request("/v1/methods")) : legacy.methods(),
    call: async (actor, thread, method, call) => {
      if (!(await modern())) return legacy.call(actor, thread, method, call)
      if (call.timeoutMs !== undefined) throw new Error("This host does not support invocation deadlines")
      await request(`${threadPath(actor, thread)}/methods/${encodeURIComponent(method)}`, { method: "POST", headers: { "idempotency-key": call.id }, body: JSON.stringify(call.input) })
      return { actor, thread, method, id: call.id }
    },
    state: async ref => {
      if (!(await modern())) return legacy.state(ref)
      if (!("method" in ref)) throw new Error("Use a method call reference for an atom host")
      return state(ref)
    },
    methodState: async (actor, thread, method, id) => await modern() ? state({ actor, thread, method, id }) : legacy.methodState(actor, thread, method, id),
    cancel: async (ref, cancellation) => {
      if (!(await modern())) return legacy.cancel(ref, cancellation)
      if (!("method" in ref)) throw new Error("Use a method call reference for an atom host")
      await request(`${threadPath(ref.actor, ref.thread)}/methods/${encodeURIComponent(ref.method)}/calls/${encodeURIComponent(ref.id)}/cancellation`, { method: "PUT", body: JSON.stringify({ reason: cancellation?.reason ?? "Cancelled by caller" }) })
      return { actor: ref.actor, thread: ref.thread, method: ref.method, call: ref.id, status: "requested" }
    },
    events: async (actor, thread, query = {}) => {
      if (!(await modern())) return legacy.events(actor, thread, query)
      const rows = Schema.decodeUnknownSync(Schema.Array(EventRow))(await request(`${threadPath(actor, thread)}/events?after=${query.after ?? 0}`))
      const selected = query.types ? rows.filter(row => query.types!.includes(row.event.type)) : rows
      return query.limit === undefined ? selected : selected.slice(0, query.limit)
    },
  }
}
