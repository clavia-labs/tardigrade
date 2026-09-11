import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBunHost, serve } from "tardie/bun"
import { cleanup, registerCleanup } from "./cleanup"
import { definition, modelLayer, responseFor, runContract } from "./contract"

for (const scenario of ["complete", "broken"] as const) test(`Bun HTTP inference: ${scenario}`, async () => {
  const storage = await mkdtemp(join(tmpdir(), "inference-e2e-"))
  let requests = 0
  const cleanups: Array<() => unknown> = [() => rm(storage, { recursive: true, force: true })]
  try {
    const provider = Bun.serve({ port: 0, fetch: async (request) => {
      requests++
      return new Response(responseFor(await request.text()), { headers: { "content-type": "text/event-stream" } })
    } })
    registerCleanup(cleanups, provider, (provider) => provider.stop(true))
    const open = () => createBunHost({ actor: definition, storage, layersFor: () => modelLayer(provider.url.toString()) })
    let host = await open()
    let closeHost = registerCleanup(cleanups, host, (host) => host.close())
    let server = await serve(host, { port: 0 })
    let closeServer = registerCleanup(cleanups, server, (server) => server.close())
    const result = await runContract((path, init) => fetch(new URL(path, server.url), init), scenario)
    expect(requests).toBe(scenario === "complete" ? 2 : 1)
    await closeServer()
    await closeHost()
    host = await open()
    closeHost = registerCleanup(cleanups, host, (host) => host.close())
    server = await serve(host, { port: 0 })
    closeServer = registerCleanup(cleanups, server, (server) => server.close())
    expect(await (await fetch(new URL(result.path, server.url))).json()).toEqual(result.state)
    expect(requests).toBe(scenario === "complete" ? 2 : 1)
  } finally {
    await cleanup(cleanups)
  }
})
