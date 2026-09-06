import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { createBunHost } from "./host"
import { Database } from "bun:sqlite"
import { actorThreadsOf } from "@clavia/tardigrade-core/actor/events"
import { threadAllocationKey } from "@clavia/tardigrade-host/allocation"

test("the actor directory retains root and child assignments across restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardigrade-allocation-"))
  let candidate = 0
  let generate: () => string = () => candidate++ < 2 ? "quiet-fox-aaaa" : "bright-owl-bbbb"
  const options = { database: join(directory, "rick.sqlite"), actorName: "tardie", actorInstance: "rick", actorFor: () => undefined, workspaceSql: false as const,
    allocation: { generate: () => generate() } }
  let host = await createBunHost(options)
  try {
    const request = { kind: "root" as const, coordinate: { actor: "tardie", instance: "rick", thread: "" }, key: "creation" }
    const changed = host.awaitActorHead(0)
    const root = await host.assignThread(request)
    expect(await changed).toBeGreaterThan(0)
    const spawn = { kind: "child" as const, parent: root, child: childKeyOf("researcher") }
    const children = await Promise.all(Array.from({ length: 10 }, () => host.allocate(spawn)))
    expect(new Set(children.map((child) => child.thread)).size).toBe(1)
    expect(children[0]!.thread).not.toBe(root.thread)
    let retries = 0
    generate = () => retries++ === 0 ? children[0]!.thread : "calm-otter-cccc"
    const siblingRequest = { ...spawn, child: childKeyOf("writer") }
    const sibling = await host.assignThread(siblingRequest)
    expect(sibling.thread).toBe("calm-otter-cccc")
    expect(retries).toBe(2)
    const allocated = actorThreadsOf((await host.readActorPage(0, 100)).map((row) => row.event))
    expect(allocated).toHaveLength(3)
    expect(allocated.find((record) => record.thread === root.thread)).toMatchObject({ allocationKey: threadAllocationKey(request), state: "allocated" })
    await expect(host.assignThread({ ...request, coordinate: { ...request.coordinate, instance: "morty" } })).rejects.toThrow("owning actor directory")
    await host.close()
    host = await createBunHost({ ...options, allocation: { generate: () => { throw new Error("must read persisted assignment") } } })
    expect(await host.allocate(request)).toEqual(root)
    expect(await host.allocate(spawn)).toEqual(children[0]!)
    expect(await host.assignThread(siblingRequest)).toEqual(sibling)
    expect((await host.read(root.thread)).filter((event) => event.type === "ThreadCreated")).toHaveLength(1)
    const records = actorThreadsOf((await host.readActorPage(0, 100)).map((row) => row.event))
    expect(records).toHaveLength(3)
    expect(records.find((record) => record.thread === root.thread)).toMatchObject({ allocationKey: threadAllocationKey(request), state: "registered" })
    const database = new Database(options.database, { readonly: true })
    try {
      expect(database.query("SELECT name FROM sqlite_master WHERE name = 'thread_assignments'").all()).toHaveLength(0)
    } finally {
      database.close()
    }
  } finally {
    await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
