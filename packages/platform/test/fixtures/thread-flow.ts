import assert from "node:assert/strict"

export const DEFAULT_THREAD_FLOW_POLICY = { timeoutMs: 5_000, pollIntervalMs: 10 }

export function threadFlow(fetcher: (request: Request) => Promise<Response>, instance: string, options: { readonly url?: string; readonly token?: string; readonly policy?: Partial<typeof DEFAULT_THREAD_FLOW_POLICY> } = {}) {
  const policy = { ...DEFAULT_THREAD_FLOW_POLICY, ...options.policy }
  const coordinate = (thread: string) => ({ actor: "layout", instance, thread })
  const request = (path = "", body?: unknown, id?: string) => fetcher(new Request(`${options.url ?? "https://layout.test"}/v1/actors/${instance}/threads${path}`, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(policy.timeoutMs),
    headers: { "content-type": "application/json", ...(id ? { "idempotency-key": id } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const result = async (thread: string, method: string, id: string) => {
    const response = await request(`/${thread}/methods/${method}/calls/${id}`)
    assert.equal(response.status, 200)
    return await response.json() as { status: string; output?: unknown }
  }
  const completed = async (thread: string, method: string, id: string, output: unknown) => {
    const deadline = Date.now() + policy.timeoutMs
    let state = await result(thread, method, id)
    while (state.status === "pending" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, policy.pollIntervalMs))
      state = await result(thread, method, id)
    }
    assert.equal(state.status, "completed", JSON.stringify(state))
    assert.deepEqual(state.output, output)
  }
  const call = async (thread: string, method: string, input: unknown, id: string, output: unknown) => {
    assert.equal((await request(`/${thread}/methods/${method}`, input, id)).status, 202)
    await completed(thread, method, id, output)
  }
  const run = async () => {
    const created = await request("", { name: "parent", initialState: { "layout.value": 32 } })
    assert.equal(created.status, 200)
    assert.deepEqual(await created.json(), coordinate("parent"))
    await call("parent", "read", null, "initial", 32)
    await call("parent", "spawn", 73, "child", coordinate("child"))
    await completed("child", "set", "child:child", 73)
    await call("parent", "read", null, "unchanged", 32)
  }
  return { coordinate, request, result, completed, call, run }
}
