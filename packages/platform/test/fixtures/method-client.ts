import assert from "node:assert/strict"
import { DEFAULT_WAIT_POLICY } from "./wait"

export const DEFAULT_METHOD_CLIENT_POLICY = DEFAULT_WAIT_POLICY

interface MethodResult {
  readonly status: string
  readonly output?: unknown
}

// methodClient submits keyed method calls and polls their terminal results (properties/checkpoint/e2e.ts, workerd/thread-layout.workers.ts).
export function methodClient(fetcher: (request: Request) => Promise<Response>, instance: string, options: {
  readonly url: string
  readonly token?: string
  readonly policy?: Partial<typeof DEFAULT_METHOD_CLIENT_POLICY>
}) {
  const policy = { ...DEFAULT_METHOD_CLIENT_POLICY, ...options.policy }
  const request = (path = "", body?: unknown, id?: string) => fetcher(new Request(`${options.url}/v1/actors/${instance}/threads${path}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(policy.timeoutMs),
    headers: { "content-type": "application/json", ...(id === undefined ? {} : { "idempotency-key": id }), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const result = async (thread: string, method: string, id: string): Promise<MethodResult> => {
    const response = await request(`/${thread}/methods/${method}/calls/${id}`)
    const body = await response.text()
    assert.equal(response.status, 200, body)
    return JSON.parse(body) as MethodResult
  }
  const completed = async (thread: string, method: string, id: string) => {
    const deadline = Date.now() + policy.timeoutMs
    let state = await result(thread, method, id)
    while (state.status === "pending" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, policy.pollIntervalMs))
      state = await result(thread, method, id)
    }
    assert.equal(state.status, "completed", JSON.stringify(state))
    return state.output
  }
  const call = async (thread: string, method: string, input: unknown, id: string) => {
    const response = await request(`/${thread}/methods/${method}`, input, id)
    assert.equal(response.status, 202, await response.text())
    return completed(thread, method, id)
  }
  return { request, result, completed, call }
}
