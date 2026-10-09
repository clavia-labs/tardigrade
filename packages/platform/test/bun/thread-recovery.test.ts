import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { createBunHost } from "../../src/bun"

const Changed = event({ type: "Changed", done: Schema.Boolean })
const done = durableAtom({ name: "recovery.done", input: Changed, schema: Schema.Boolean, initial: false, reduce: (_, event) => event.done })
const actor = defineActor("retained-reference", Effect.succeed({
  atom: effectAtom(get => ({ view: get(done), events: {}, acts: {} })),
  methods: { set: actorMethod({
    inputSchema: Schema.Boolean, outputSchema: Schema.Boolean,
    onReceive: Changed.from(done => ({ done })),
    result: (_, get) => get(done) ? { status: "completed", output: true } : undefined,
  }) },
}))

test("live inline execution is running until settlement", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-inline-recovery-"))
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  const Job = act({ name: "recovery.inline", input: Schema.Null, success: Schema.Boolean, failure: Schema.String })
  const inlineActor = defineActor("inline-recovery", Effect.sync(() => {
    const job = Job.request({ input: null })
    return { atom: effectAtom(get => ({ view: get(job.result), events: {}, acts: get(done) && get(job.result).status === "pending" ? { job } : {} })),
      methods: { run: actorMethod({ inputSchema: Schema.Boolean, outputSchema: Schema.Boolean, onReceive: Changed.from(done => ({ done })), result: (_, get) => {
        const result = get(job.result)
        return result.status === "fulfilled" ? { status: "completed", output: result.value } : undefined
      } }) },
    }
  }))
  const host = await Effect.runPromise(createBunHost({ actor: inlineActor, storage, actorContext: Context.pick(), services: () => Job.layer(() =>
    Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(true)),
  ) }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(ref.invoke("run", true, { id: "run" }))
    await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout(1_000)))
    expect(await Effect.runPromise(host.probe(ref.coordinate))).toMatchObject({ status: "running" })
    expect((await Effect.runPromise(host.probe(ref.coordinate)))?.wakeAt).toBeUndefined()
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(ref.wait.pipe(Effect.timeout(1_000)))
    expect(await Effect.runPromise(ref.methodState("run", "run"))).toEqual({ status: "completed", output: true })
    expect(await Effect.runPromise(host.probe(ref.coordinate))).toMatchObject({ status: "settled" })
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(host.close)
    await rm(storage, { recursive: true, force: true })
  }
})

test("thread references and projections follow runtime replacement", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-thread-recovery-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    const selection = ref.store.select(done)
    const values: boolean[] = []
    const stop = selection.subscribe(value => { values.push(value) })
    await Effect.runPromise(host.invalidate(ref.coordinate))
    expect(() => ref.getState()).toThrow("unavailable during recovery")
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.invoke("set", true, { id: "after" }))
    await Effect.runPromise(ref.wait)
    expect(await Effect.runPromise(ref.methodState("set", "after"))).toEqual({ status: "completed", output: true })
    expect(ref.get(done)).toBe(true)
    expect(ref.getState().view).toBe(true)
    expect(selection.get()).toBe(true)
    expect(values).toEqual([true])
    stop()
    await Effect.runPromise(host.invalidate(ref.coordinate))
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.invoke("set", false, { id: "unsubscribed" }))
    await Effect.runPromise(ref.wait)
    expect(values).toEqual([true])
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("pending method results survive runtime replacement", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-result-recovery-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(ref.invoke("set", false, { id: "before" }))
    await Effect.runPromise(ref.wait)
    const waiter = Effect.runFork(ref.result("set", "before"))
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(host.invalidate(ref.coordinate))
    await Effect.runPromise(host.recover(ref.coordinate))
    await Effect.runPromise(ref.methods.set(true, { id: "after" }).pipe(Effect.timeout(1_000)))
    expect(await Effect.runPromise(Fiber.join(waiter).pipe(Effect.timeout(1_000)))).toEqual({ status: "completed", output: true })
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})


test("replacement waits until the old runtime releases its services", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-lifecycle-recovery-"))
  const releasing = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let acquisitions = 0
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.effectDiscard(Effect.acquireRelease(
    Effect.sync(() => { acquisitions++ }),
    () => acquisitions === 1 ? Deferred.succeed(releasing, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void,
  )) }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    const invalidation = Effect.runFork(host.invalidate(ref.coordinate))
    await Effect.runPromise(Deferred.await(releasing))
    const recovery = Effect.runFork(host.recover(ref.coordinate))
    await Effect.runPromise(Effect.sleep(5))
    expect(acquisitions).toBe(1)
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(Fiber.join(invalidation))
    await Effect.runPromise(Fiber.join(recovery).pipe(Effect.timeout(1_000)))
    expect(acquisitions).toBe(2)
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await Effect.runPromise(host.close)
    await rm(storage, { recursive: true, force: true })
  }
})
