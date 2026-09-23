import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { Checkpoint, checkpointLayer } from "./checkpoint"

const waitFor = async (ready: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (ready()) return
    await Bun.sleep(10)
  }
  throw new Error("worker did not reach the expected state")
}

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "checkpoint-worker-test-"))
  const storage = join(directory, "storage")
  await mkdir(storage)
  await writeFile(join(storage, "notes-journal"), "keep this ordinary file")
  const ready = join(directory, "ready")
  const release = join(directory, "release")
  const entry = join(directory, "worker.ts")
  await writeFile(entry, `
    import { existsSync, writeFileSync } from "node:fs"
    writeFileSync(${JSON.stringify(ready)}, "ready")
    while (!existsSync(${JSON.stringify(release)})) Bun.sleepSync(5)
    await import(${JSON.stringify(new URL("./checkpoint-worker.ts", import.meta.url).href)})
  `)
  return { directory, storage, ready, release, entry }
}

test("checkpoint worker leaves the host responsive, is reused, and closes with its layer", async () => {
  const files = await fixture()
  let spawned = 0
  let closed = false
  const layer = checkpointLayer({ timeoutMs: 5000, spawn: () => {
    spawned++
    const worker = new Worker(files.entry)
    worker.addEventListener("close", () => { closed = true })
    return worker
  } })
  const capture = Effect.gen(function*() {
    const checkpoint = yield* Checkpoint
    const request = { actor: "test", storage: files.storage, maxBytes: 10000 }
    const first = yield* checkpoint.capture(request)
    const second = yield* checkpoint.capture(request)
    expect(second.digest).toBe(first.digest)
    expect(JSON.parse(new TextDecoder().decode(first.payload)).files[0].path).toBe("notes-journal")
    expect(spawned).toBe(1)
    expect(closed).toBe(false)
  })
  try {
    const running = Effect.runPromise(Effect.provide(capture, layer))
    await waitFor(() => existsSync(files.ready))
    await writeFile(files.release, "release")
    await running
    await waitFor(() => closed)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
})

test("a timed out capture terminates its worker and the next capture starts a new worker", async () => {
  const files = await fixture()
  let spawned = 0
  let closed = 0
  const layer = checkpointLayer({ timeoutMs: 5000, spawn: () => {
    const worker = new Worker(spawned++ === 0 ? files.entry : new URL("./checkpoint-worker.ts", import.meta.url))
    worker.addEventListener("close", () => { closed++ })
    return worker
  } })
  try {
    await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const checkpoint = yield* Checkpoint
      const request = { actor: "test", storage: files.storage, maxBytes: 10000 }
      const error = yield* checkpoint.capture(request).pipe(Effect.flip)
      expect(error.message).toBe("checkpoint capture exceeded 5000ms")
      expect((yield* checkpoint.capture(request)).actor).toBe("test")
      expect(spawned).toBe(2)
    }), layer))
    await waitFor(() => closed === 2)
  } finally {
    await rm(files.directory, { recursive: true, force: true })
  }
}, 15000)


test("closing an in-flight capture terminates the blocked worker", async () => {
  const files = await fixture()
  let closed = false
  const layer = checkpointLayer({ timeoutMs: 5000, spawn: () => {
    const worker = new Worker(files.entry)
    worker.addEventListener("close", () => { closed = true })
    return worker
  } })
  const fiber = Effect.runFork(Effect.gen(function*() {
    const checkpoint = yield* Checkpoint
    yield* checkpoint.capture({ actor: "test", storage: files.storage, maxBytes: 10000 })
  }).pipe(Effect.provide(layer)))
  try {
    await waitFor(() => existsSync(files.ready))
    await Effect.runPromise(Fiber.interrupt(fiber))
    await waitFor(() => closed)
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    await rm(files.directory, { recursive: true, force: true })
  }
})
