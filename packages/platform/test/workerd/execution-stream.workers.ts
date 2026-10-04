import { env } from "cloudflare:workers"
import { SELF, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { cloudflareThreadName } from "../../src/cloudflare"
import { threadFlow } from "../fixtures/thread-flow"
import type { LayoutThreadDO } from "./layout-fixture"

test("thread DO streams live act updates without journal entries", async () => {
  const instance = "execution-stream"
  const address = { actor: "layout", instance, thread: "parent" }
  const parent = (env as unknown as { THREADS: DurableObjectNamespace<LayoutThreadDO> }).THREADS.getByName(cloudflareThreadName(address))
  const flow = threadFlow(request => SELF.fetch(request), instance)
  expect((await flow.request("", { name: "parent" })).status).toBe(200)
  await parent.blockSpawns(true)
  const response = await flow.request("/parent/execution/stream")
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  try {
    const update = reader.read()
    expect((await flow.request("/parent/methods/spawn", 73, "child")).status).toBe(202)
    const frame = new TextDecoder().decode((await update).value)
    const data = frame.split("\n").find(line => line.startsWith("data:"))!.slice(5)
    expect(JSON.parse(data)).toMatchObject({ address, ref: { atom: "layout", act: "layout.spawn" }, payload: { type: "tool.progress", message: "spawning" } })
    expect(JSON.stringify(await parent.records())).not.toContain("tool.progress")
  } finally {
    await reader.cancel()
    await parent.blockSpawns(false)
    await runInDurableObject(parent, object => object.dispose())
  }
  await parent.wake()
  await flow.completed("parent", "spawn", "child", flow.coordinate("child"))
})
