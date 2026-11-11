import { env } from "cloudflare:workers"
import { evictDurableObject, runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import worker, { layerLifetimes, layerModelCalls, layerSetupIsolation, type HostLayerActorDO, type HostLayerThreadDO, type HostLayerEnv } from "../fixtures/workerd/host-layer.worker"
import { cloudflareThreadName } from "../../src/cloudflare"

const bindings = env as unknown as HostLayerEnv & {
  HOST_LAYER_ACTORS: DurableObjectNamespace<HostLayerActorDO>
  HOST_LAYER_THREADS: DurableObjectNamespace<HostLayerThreadDO>
}
const request = (path: string, body?: unknown, id?: string) => worker.fetch(new Request(`http://test${path}`, {
  ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  ...(id === undefined ? {} : { headers: { "idempotency-key": id } }),
}), { ...bindings, ACTORS: bindings.HOST_LAYER_ACTORS, THREADS: bindings.HOST_LAYER_THREADS })

test("a direct host layer gets platform services, isolated scopes, cleanup, and agent adapters", async () => {
  const instance = `layer-${crypto.randomUUID()}`
  const base = `/v1/actors/${instance}/threads`
  const thread = (name: string) => bindings.HOST_LAYER_THREADS.getByName(cloudflareThreadName({ actor: "layer-agent", instance, thread: name }))
  const lifetimes = () => layerLifetimes().filter(value => value.instance === instance)
  const message = async (name: string, id: string) => {
    const route = `${base}/${name}/methods/message`
    expect((await request(route, { text: "Record the finding." }, id)).status).toBe(202)
    await expect.poll(async () => (await request(`${route}/calls/${id}`)).json()).toEqual({ id, method: "message", status: "completed", output: { text: "ok" } })
  }
  try {
    const beforeInspection = layerLifetimes().length
    expect((await request("/v1/methods")).status).toBe(200)
    const inspection = layerLifetimes().slice(beforeInspection)
    expect(inspection.length).toBeGreaterThan(0)
    expect(inspection.every(value => value.thread === "$methods" && value.closed && !value.ready)).toBe(true)
    for (const name of ["first", "sibling"]) {
      expect((await request(base, { name })).status).toBe(200)
      await message(name, "finding")
      await runInDurableObject(thread(name), async (_object, state) => {
        expect(await state.storage.get("note:research.md")).toBe(`host-provided:${name}:A durable finding.`)
      })
    }
    const first = lifetimes().find(value => value.thread === "first" && !value.closed)!
    const sibling = lifetimes().find(value => value.thread === "sibling" && !value.closed)!
    expect(first.ready && sibling.ready).toBe(true)
    expect(first.id).not.toBe(sibling.id)
    const siblingHistory = await thread("sibling").records()
    const callsBeforeRestart = layerModelCalls()
    await thread("first").dispose()
    expect(first.closed).toBe(true)
    expect(sibling.closed).toBe(false)
    await evictDurableObject(thread("first"))
    const recovered = await request(`${base}/first/methods/message/calls/finding`)
    expect(await recovered.json()).toEqual({ id: "finding", method: "message", status: "completed", output: { text: "ok" } })
    expect(layerModelCalls()).toBe(callsBeforeRestart)
    expect(lifetimes().filter(value => value.thread === "first" && value.ready)).toHaveLength(2)
    await runInDurableObject(thread("first"), async (_object, state) => {
      expect(await state.storage.get("note:research.md")).toBe("host-provided:first:A durable finding.")
    })
    await message("first", "continued")
    expect(layerModelCalls()).toBe(callsBeforeRestart + 1)
    expect(await thread("sibling").records()).toEqual(siblingHistory)
    await runInDurableObject(bindings.HOST_LAYER_ACTORS.getByName(instance), async (_object, state) => {
      expect(await state.storage.get("note:research.md")).toBeUndefined()
    })
  } finally {
    await Promise.all([thread("first").dispose(), thread("sibling").dispose()])
  }
  expect(lifetimes().every(value => value.closed)).toBe(true)
  expect(layerSetupIsolation().length).toBeGreaterThan(0)
  expect(layerSetupIsolation().every(Boolean)).toBe(true)
})
