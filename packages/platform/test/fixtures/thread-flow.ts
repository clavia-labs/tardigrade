import assert from "node:assert/strict"
import { methodClient, DEFAULT_METHOD_CLIENT_POLICY } from "./method-client"

export const DEFAULT_THREAD_FLOW_POLICY = DEFAULT_METHOD_CLIENT_POLICY

export function threadFlow(fetcher: (request: Request) => Promise<Response>, instance: string, options: { readonly url?: string; readonly token?: string; readonly policy?: Partial<typeof DEFAULT_THREAD_FLOW_POLICY> } = {}) {
  const client = methodClient(fetcher, instance, { ...options, url: options.url ?? "https://layout.test" })
  const coordinate = (thread: string) => ({ actor: "layout", instance, thread })
  const { request, result } = client
  const completed = async (thread: string, method: string, id: string, output: unknown) => {
    assert.deepEqual(await client.completed(thread, method, id), output)
  }
  const call = async (thread: string, method: string, input: unknown, id: string, output: unknown) => {
    assert.deepEqual(await client.call(thread, method, input, id), output)
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
