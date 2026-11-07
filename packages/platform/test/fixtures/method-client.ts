import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import { createMethodClient } from "../../src/client"
import { DEFAULT_WAIT_POLICY } from "./wait"

export const DEFAULT_METHOD_CLIENT_POLICY = DEFAULT_WAIT_POLICY

// methodClient submits keyed method calls and polls their terminal results (properties/checkpoint/e2e.ts, workerd/thread-layout.workers.ts).
export function methodClient(fetcher: (request: Request) => Promise<Response>, instance: string, options: {
  readonly url: string
  readonly token?: string
  readonly policy?: Partial<typeof DEFAULT_METHOD_CLIENT_POLICY>
}) {
  const policy = { ...DEFAULT_METHOD_CLIENT_POLICY, ...options.policy }
  const remote = (thread: string, method: string) => createMethodClient({
    url: options.url, instance, thread, fetch: fetcher,
    ...(options.token === undefined ? {} : { token: options.token }),
    methods: { [method]: { inputSchema: Schema.Json, outputSchema: Schema.Json } },
    policy: { requestTimeoutMs: policy.timeoutMs, resultTimeoutMs: policy.timeoutMs, pollIntervalMs: policy.pollIntervalMs },
  })
  const request = (path = "", body?: unknown, id?: string) => fetcher(new Request(`${options.url}/v1/actors/${instance}/threads${path}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(policy.timeoutMs),
    headers: { "content-type": "application/json", ...(id === undefined ? {} : { "idempotency-key": id }), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const result = (thread: string, method: string, id: string) => Effect.runPromise(remote(thread, method).result(method, id))
  const completed = async (thread: string, method: string, id: string): Promise<unknown> => {
    const state = await Effect.runPromise(remote(thread, method).wait(method, id))
    if (state.status !== "completed") assert.fail(JSON.stringify(state))
    return state.output
  }
  const call = async (thread: string, method: string, input: unknown, id: string) => {
    await Effect.runPromise(remote(thread, method).invoke(method, Schema.decodeUnknownSync(Schema.Json)(input), { id }))
    return completed(thread, method, id)
  }
  return { request, result, completed, call }
}
