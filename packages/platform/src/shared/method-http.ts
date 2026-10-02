import { Cause, Effect, Exit, Schema } from "effect"
import { InitialState, InvalidMessage, MessageConflict, type ActorMethods, type MethodInput, type MethodResult, type MessageReceipt, type ThreadCoordinate, type ThreadRequest, type Recorded } from "@clavia/tardigrade-core"
import { jsonSchemaOf } from "@clavia/tardigrade-core/json-schema"

export const DEFAULT_METHOD_HTTP_INSTANCE = "main"

export interface MethodHttpOptions {
  readonly instance?: string
  readonly token?: string
}

interface MethodHttpThread<Contracts extends ActorMethods<object>> {
  readonly contracts: Contracts
  readonly coordinate: ThreadCoordinate
  readonly records: () => Effect.Effect<readonly Recorded<unknown>[], Error>
  readonly invoke: <Name extends keyof Contracts & string>(method: Name, input: MethodInput<Contracts[Name]>, request: { readonly id: string }) => Effect.Effect<MessageReceipt, Error>
  readonly methodState: (method: keyof Contracts & string, id: string) => Effect.Effect<MethodResult<Schema.Json> | { readonly status: "pending" }, Error>
  readonly cancel: (method: keyof Contracts & string, id: string, reason: string) => Effect.Effect<MessageReceipt, Error>
}

interface MethodHttpHost<Contracts extends ActorMethods<object>> {
  readonly actor: string
  readonly methodContracts: (input: { readonly instance: string }) => Effect.Effect<Contracts, Error>
  readonly getThread: (input: { readonly instance: string; readonly thread: string }) => Effect.Effect<MethodHttpThread<Contracts> | undefined, Error>
  readonly allocateRootThread: (input: Omit<ThreadRequest, "parent">) => Effect.Effect<{ readonly coordinate: ThreadCoordinate }, Error>
  readonly allocateChildThread: (input: Omit<ThreadRequest, "instance" | "parent"> & { readonly parent: ThreadCoordinate }) => Effect.Effect<{ readonly coordinate: ThreadCoordinate }, Error>
}

// methodHttp exposes typed invocation, cancellation, and log inspection for a thread host (apps/cli/src/init-flow.test.ts).
export function methodHttp<Contracts extends ActorMethods<object>>(
  host: MethodHttpHost<Contracts>,
  options: MethodHttpOptions = {},
) {
  const run = async <Value>(effect: Effect.Effect<Value, Error>) => {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    return exit.value
  }
  const json = (value: unknown, status = 200) => Response.json(value, { status })
  const summaries = (methods: Contracts) => Object.entries(methods).map(([name, method]) => ({
    name, cancellable: method.onCancel !== undefined,
    inputSchema: jsonSchemaOf(method.inputSchema),
    outputSchema: jsonSchemaOf(method.outputSchema),
  }))
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/healthz") return json({ status: "resting", dirty: 0 })
    if (options.token !== undefined && request.headers.get("authorization") !== `Bearer ${options.token}`) return json({ error: "Unauthorized" }, 401)
    if (request.method === "GET" && url.pathname === "/v1/metadata") return json({ name: host.actor, api: "atoms" })
    if (request.method === "GET" && url.pathname === "/v1/methods") {
      try { return json(summaries(await run(host.methodContracts({ instance: options.instance ?? DEFAULT_METHOD_HTTP_INSTANCE })))) }
      catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 500) }
    }
    const match = /^\/v1\/actors\/([^/]+)\/threads(?:\/([^/]+))?(?:\/(.*))?$/.exec(url.pathname)
    if (!match) return json({ error: "Not found" }, 404)
    const instance = decodeURIComponent(match[1]!)
    const name = match[2] === undefined ? undefined : decodeURIComponent(match[2])
    try {
      if (request.method === "POST" && name === undefined) {
        const input = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.optionalKey(Schema.NonEmptyString), parent: Schema.optionalKey(Schema.NonEmptyString), initialState: Schema.optionalKey(InitialState) }), { onExcessProperty: "error" })(await request.json())
        const allocation = { ...(input.name === undefined ? {} : { name: input.name }), ...(input.initialState === undefined ? {} : { initialState: input.initialState }) }
        const thread = await run(input.parent === undefined
          ? host.allocateRootThread({ instance, ...allocation })
          : host.allocateChildThread({ parent: { actor: host.actor, instance, thread: input.parent }, ...allocation }))
        return json(thread.coordinate)
      }
      if (name === undefined) return json({ error: "Not found" }, 404)
      const thread = await run(host.getThread({ instance, thread: name }))
      if (!thread) return json({ error: "Unknown thread" }, 404)
      const path = match[3] ?? ""
      if (request.method === "GET" && path === "events") {
        const after = Number(url.searchParams.get("after") ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) return json({ error: "after must be a nonnegative integer" }, 400)
        const records = await run(thread.records())
        return json(records.map((record, index) => ({ seq: index + 1, event: record.event })).filter(row => row.seq > after))
      }
      const methodPath = /^methods\/([^/]+)(?:\/calls\/([^/]+)(\/cancellation)?)?$/.exec(path)
      if (!methodPath) return json({ error: "Not found" }, 404)
      const method = decodeURIComponent(methodPath[1]!)
      if (!Object.hasOwn(thread.contracts, method)) return json({ error: "Unknown method" }, 404)
      const call = methodPath[2] === undefined ? undefined : decodeURIComponent(methodPath[2])
      if (request.method === "POST" && call === undefined) {
        if (url.searchParams.has("timeoutMs")) return json({ error: "Invocation deadlines are not supported by this host" }, 400)
        const id = request.headers.get("idempotency-key")
        if (!id?.trim()) return json({ error: "Idempotency-Key is required" }, 400)
        await run(thread.invoke(method as keyof Contracts & string, Schema.decodeUnknownSync(Schema.toType(thread.contracts[method]!.inputSchema))(await request.json()) as MethodInput<Contracts[keyof Contracts & string]>, { id }))
        return json({ actor: instance, thread: name, method, id }, 202)
      }
      if (call !== undefined && request.method === "GET" && !methodPath[3]) return json(await run(thread.methodState(method as keyof Contracts & string, call)))
      if (call !== undefined && request.method === "PUT" && methodPath[3]) {
        if (!thread.contracts[method]?.onCancel) return json({ error: "Method does not support cancellation" }, 400)
        const input = Schema.decodeUnknownSync(Schema.Struct({ reason: Schema.String }), { onExcessProperty: "error" })(await request.json())
        await run(thread.cancel(method as keyof Contracts & string, call, input.reason))
        return json({ actor: instance, thread: name, method, call, status: "requested" }, 202)
      }
      return json({ error: "Not found" }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, error instanceof MessageConflict ? 409 : error instanceof InvalidMessage || Schema.isSchemaError(error) ? 400 : 500)
    }
  }
}
