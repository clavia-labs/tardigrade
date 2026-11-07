import { Effect, Schema } from "effect"
import { RuntimeError, methodResult, type InitialState, type ActorMethod, type MethodResult } from "@clavia/tardigrade-core"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { MethodApi } from "./http"

export type MethodContract = Pick<ActorMethod<object>, "inputSchema" | "outputSchema">
export type MethodContracts = Readonly<Record<string, MethodContract>>
export const DEFAULT_METHOD_CLIENT_POLICY = { requestTimeoutMs: 30_000, pollIntervalMs: 100, resultTimeoutMs: 30_000 } as const
export interface MethodClientPolicy { readonly requestTimeoutMs: number; readonly pollIntervalMs: number; readonly resultTimeoutMs: number }
export interface MethodCall { readonly instance: string; readonly thread: string; readonly method: string; readonly id: string }
export type RemoteMethodState<Output> = MethodResult<Output> | { readonly status: "pending" }

export class MethodClientHttpError extends Error {
  readonly _tag = "MethodClientHttpError"
  constructor(readonly status: number, readonly body: string) { super(`Method endpoint returned HTTP ${status}: ${body}`) }
}

const ResultIdentity = Schema.Struct({ method: Schema.String, id: Schema.String })
const Pending = Schema.Struct({ status: Schema.Literal("pending") })

// createMethodClient submits stable call identities and reads schema-checked results without owning server execution (packages/platform/test/workerd/cluster-client.workers.ts).
export function createMethodClient<const Contracts extends MethodContracts>(options: {
  readonly url: string
  readonly instance: string
  readonly thread: string
  readonly methods: Contracts
  readonly fetch: (request: Request) => Promise<Response>
  readonly token?: string
  readonly policy?: Partial<MethodClientPolicy>
}) {
  const policy = { ...DEFAULT_METHOD_CLIENT_POLICY, ...options.policy }
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < 1) throw new RuntimeError(`Method client ${key} must be a positive safe integer`)
  const params = { instance: options.instance, thread: options.thread }
  const transport = HttpClient.make((request, _url, signal) => HttpClientRequest.toWeb(request, { signal }).pipe(
    Effect.flatMap(web => Effect.tryPromise({ try: () => options.fetch(web), catch: RuntimeError.from })),
    Effect.map(response => HttpClientResponse.fromWeb(request, response)),
    Effect.mapError(cause => new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, cause }) })),
  ))
  const api = Effect.runSync(HttpApiClient.makeWith(MethodApi, {
    baseUrl: options.url.replace(/\/$/, ""),
    httpClient: options.token === undefined ? transport : HttpClient.mapRequest(transport, HttpClientRequest.bearerToken(options.token)),
  })).thread
  const decode = <Value>(schema: Schema.Schema<Value>, value: unknown) => Schema.decodeUnknownEffect(Schema.toType(schema))(value).pipe(Effect.mapError(RuntimeError.from))
  const requestError = (cause: unknown) => cause instanceof MethodClientHttpError ? cause : RuntimeError.from(cause)
  const errorOf = (cause: unknown) => {
    if (cause instanceof HttpClientError.HttpClientError) {
      const response = cause.response
      if (response && (response.status < 200 || response.status >= 300)) {
        return response.text.pipe(Effect.map(body => new MethodClientHttpError(response.status, body)), Effect.orElseSucceed(() => RuntimeError.from(cause)))
      }
      if (cause.reason._tag === "TransportError") return Effect.succeed(requestError(cause.reason.cause))
    }
    return Effect.succeed(requestError(cause))
  }
  const request = <Value, Failure>(work: Effect.Effect<Value, Failure>) => work.pipe(
    Effect.catch(cause => errorOf(cause).pipe(Effect.flatMap(Effect.fail))),
    Effect.timeout(policy.requestTimeoutMs), Effect.mapError(requestError),
  )
  const contract = <Name extends keyof Contracts & string>(method: Name) => Effect.try({ try: () => {
    if (!Object.hasOwn(options.methods, method)) throw new RuntimeError(`Unknown method: ${method}`)
    return options.methods[method]!
  }, catch: RuntimeError.from })
  const identity = (method: string, id: string): MethodCall => ({ instance: options.instance, thread: options.thread, method, id })
  const validateId = (id: string) => decode(Schema.NonEmptyString, id).pipe(Effect.filterOrFail(value => value.trim().length > 0 && value === value.trim(), () => new RuntimeError("Method call id must be nonempty with no surrounding whitespace")))
  const result = <Name extends keyof Contracts & string>(method: Name, id: string): Effect.Effect<RemoteMethodState<Contracts[Name]["outputSchema"]["Type"]>, Error> => Effect.gen(function* () {
    yield* validateId(id)
    const definition = yield* contract(method)
    const body = yield* request(api.result({ params: { ...params, method, id } }))
    const received = yield* decode(ResultIdentity, body)
    if (received.method !== method || received.id !== id) return yield* Effect.fail(new RuntimeError("Method endpoint returned a different call"))
    return yield* decode(Schema.Union([methodResult<Contracts[Name]["outputSchema"]["Type"]>(definition.outputSchema), Pending]), body)
  })
  return {
    policy,
    createThread: (input: { readonly parent?: string; readonly initialState?: InitialState } = {}) => Effect.gen(function* () {
      const coordinate = yield* request(api.create({ params: { instance: options.instance }, payload: { name: options.thread, ...input } }))
      if (coordinate.instance !== options.instance || coordinate.thread !== options.thread) return yield* Effect.fail(new RuntimeError("Method endpoint returned a different thread"))
      return coordinate
    }),
    invoke: <Name extends keyof Contracts & string>(method: Name, input: Contracts[Name]["inputSchema"]["Type"], call: { readonly id: string }) => Effect.gen(function* () {
      yield* validateId(call.id)
      const definition = yield* contract(method)
      const value = yield* decode(definition.inputSchema, input)
      const accepted = yield* request(api.invoke({ params: { ...params, method }, headers: { "idempotency-key": call.id }, payload: value }))
      if (accepted.actor !== options.instance || accepted.thread !== options.thread || accepted.method !== method || accepted.id !== call.id) return yield* Effect.fail(new RuntimeError("Method endpoint accepted a different call"))
      return identity(method, call.id)
    }),
    result,
    wait: <Name extends keyof Contracts & string>(method: Name, id: string) => Effect.gen(function* () {
      while (true) {
        const state = yield* result(method, id)
        if (state.status !== "pending") return state
        yield* Effect.sleep(policy.pollIntervalMs)
      }
    }).pipe(Effect.timeout(policy.resultTimeoutMs), Effect.mapError(requestError)),
    cancel: (method: keyof Contracts & string, id: string, reason: string) => Effect.gen(function* () {
      yield* validateId(id)
      yield* contract(method)
      const accepted = yield* request(api.cancel({ params: { ...params, method, id }, payload: { reason } }))
      if (accepted.actor !== options.instance || accepted.thread !== options.thread || accepted.method !== method || accepted.call !== id) return yield* Effect.fail(new RuntimeError("Method endpoint cancelled a different call"))
      return identity(method, id)
    }),
  }
}
