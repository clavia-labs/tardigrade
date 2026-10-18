import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { act, actorMethod, createActorStore, defineActor, durableAtom, effectAtom, event, EffectExecution, RuntimeError, WatchdogTerminalError, ActorCommitError, type Journal, type Recorded, type RuntimeEvent, type MessageDelivery } from "@clavia/tardigrade-core"
import { bunJournal, createBunHost, methodHttp } from "../../src/bun"

const Mode = Schema.Literals(["success", "failure", "defect", "interrupt"])
const Started = event({ type: "Started", id: Schema.String, mode: Mode })
const Finished = event({ type: "Finished", id: Schema.String })
type Event = typeof Started.Type | typeof Finished.Type
const Job = act({ name: "test.defect", input: Mode, success: Schema.String, failure: Schema.Struct({ code: Schema.String }) })
const starts = durableAtom({ name: "defect.starts", input: Started,
  schema: Schema.Array(Schema.Struct({ id: Schema.String, mode: Mode, origin: Schema.Finite })), initial: [],
  reduce: (state, entry, _, origin) => [...state, { id: entry.id, mode: entry.mode, origin }],
})
const actor = defineActor("execution-defect", Effect.sync(() => {
  const requests = new Map<string, ReturnType<typeof Job.request>>()
  const requestFor = (entry: { readonly id: string; readonly mode: typeof Mode.Type; readonly origin: number }) => {
    let request = requests.get(entry.id)
    if (!request) {
      request = Job.request({ input: entry.mode, origin: entry.origin, onSettled: () => [Finished.make({ id: entry.id })] })
      requests.set(entry.id, request)
    }
    return request
  }
  return {
    schema: Schema.Union([Started, Finished]),
    atom: effectAtom(get => ({ view: null, events: {}, acts: Object.fromEntries(get(starts).map(entry => [entry.id, requestFor(entry)])) })),
    methods: { run: actorMethod({ inputSchema: Mode, outputSchema: Schema.String,
      onReceive: Started.from((mode, context) => ({ id: context.id, mode })),
      result: (_, get, context) => {
        const entry = get(starts).find(entry => entry.id === context.id)
        if (!entry) return undefined
        const result = get(requestFor(entry).result)
        return result.status === "fulfilled" ? { status: "completed", output: result.value }
          : result.status === "rejected" ? { status: "failed", error: "code" in result.reason ? result.reason.code : result.reason._tag }
          : undefined
      },
    }) },
  }
}))

test("execution defects fail waiting callers and HTTP status durably without entering the declared failure channel", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-execution-defect-"))
  const entered = Deferred.makeUnsafe<void>()
  const release = Deferred.makeUnsafe<void>()
  let executions = 0
  const open = () => Effect.runPromise(createBunHost({ actor, storage, checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, actorContext: Context.pick(), services: () => Job.layer(mode => Effect.gen(function* () {
    executions++
    if (mode === "failure") return yield* Effect.fail({ code: "expected" })
    if (mode === "defect") {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      throw new Error("validator exploded")
    }
    return "ok"
  })) }))
  let host = await open()
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(ref.invoke("run", "success", { id: "success" }))
    await Effect.runPromise(ref.wait)
    expect(await Effect.runPromise(ref.result("run", "success").pipe(Effect.timeout(500)))).toEqual({ status: "completed", output: "ok" })
    await Effect.runPromise(ref.invoke("run", "failure", { id: "failure" }))
    await Effect.runPromise(ref.wait)
    expect(await Effect.runPromise(ref.methodState("run", "failure"))).toEqual({ status: "failed", error: "expected" })
    await Effect.runPromise(ref.invoke("run", "defect", { id: "defect" }))
    await Effect.runPromise(Deferred.await(entered))
    const waiting = Effect.runFork(ref.result("run", "defect"))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    const result = await Effect.runPromise(Fiber.join(waiting).pipe(Effect.timeout(2_000)))
    expect(result.status).toBe("failed")
    expect(result.status === "failed" && result.error).toContain("validator exploded")
    expect(await Effect.runPromise(Effect.flip(ref.wait))).toBeInstanceOf(WatchdogTerminalError)
    const records = await Effect.runPromise(ref.records())
    expect(records.filter(record => record.event.type === "EffectDied")).toHaveLength(1)
    expect(records.filter(record => record.event.type === "Finished")).toHaveLength(2)
    expect(await Effect.runPromise(ref.methodState("run", "success"))).toEqual({ status: "completed", output: "ok" })
    const response = await methodHttp(host)(new Request("http://test/v1/actors/main/threads/one/methods/run/calls/defect"))
    expect((await response.json() as { status: string }).status).toBe("failed")
    await Effect.runPromise(host.close)
    host = await open()
    const reopened = (await Effect.runPromise(host.getThread(ref.coordinate)))!
    expect(await Effect.runPromise(reopened.methodState("run", "defect"))).toEqual(result)
    expect(await Effect.runPromise(reopened.result("run", "defect"))).toEqual(result)
    expect(await Effect.runPromise(reopened.methodState("run", "success"))).toEqual({ status: "completed", output: "ok" })
    expect(executions).toBe(3)
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})

test("pure interruption remains pending and reuses the accepted reference on reopening", async () => {
  let attempts = 0
  let complete = false
  const open = (events: readonly RuntimeEvent<Event>[]) => Effect.runPromise(createActorStore({
    actor, events, actorContext: Context.pick(), services: () => Job.layer(() => Effect.suspend(() => { attempts++; return complete ? Effect.succeed("ok") : Effect.interrupt })),
  }))
  let store = await open([Started.make({ id: "interrupted", mode: "interrupt" })])
  try {
    await Effect.runPromise(store.wait)
    expect(store.recoveryState().status).toBe("pending")
    const history = [...store.snapshot().events]
    expect(history.some(event => event.type === "EffectDied")).toBe(false)
    const request = history.find(event => event.type === "EffectRequested")
    await Effect.runPromise(store.close)
    const interruptedAttempts = attempts
    complete = true
    store = await open(history)
    await Effect.runPromise(store.wait)
    expect(attempts).toBe(interruptedAttempts + 1)
    const settled = [...store.snapshot().events].find(event => event.type === "EffectSettled")
    expect(settled && "ref" in settled && settled.ref).toEqual(request && "ref" in request && request.ref)
    expect([...store.snapshot().events].filter(event => event.type === "EffectRequested")).toHaveLength(1)
  } finally { await Effect.runPromise(store.close) }
})

test("failed defect persistence leaves the committed invocation pending", async () => {
  const records: Recorded<Event>[] = [{ event: Started.make({ id: "uncommitted", mode: "defect" }) }]
  const journal: Journal<Event> = {
    readInputs: Effect.succeed([]),
    read: Effect.sync(() => [...records]), readAfter: position => Effect.sync(() => records.slice(position)),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: Journal requires undefined.
    readCheckpoint: Effect.succeed(undefined),
    append: (_, batch) => batch.some(record => record.event.type === "EffectDied")
      ? Effect.fail(new RuntimeError("storage unavailable"))
      : Effect.sync(() => { records.push(...batch) }),
    appendWithCheckpoint: () => Effect.fail(new RuntimeError("Unexpected checkpoint")),
  }
  const store = await Effect.runPromise(createActorStore({ actor, journal, actorContext: Context.pick(),
    services: () => Job.layer(() => Effect.die(new Error("explicit defect"))),
  }))
  try {
    expect(String(await Effect.runPromise(Effect.flip(store.wait)))).toContain("ActorCommitError")
    expect(await Effect.runPromise(Effect.flip(store.resume))).toBeInstanceOf(ActorCommitError)
    expect(records.some(record => record.event.type === "EffectDied")).toBe(false)
    expect([...store.snapshot().events].some(event => event.type === "EffectDied")).toBe(false)
  } finally { await Effect.runPromise(store.close) }
})

test("a terminal defect still delivers the durable failure reply while domain driving is blocked", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-defect-reply-"))
  const journal = bunJournal<Event>({ actor: "events", filename: join(storage, "events.sqlite") })
  const replies: MessageDelivery[] = []
  let canDrive = true
  const options = {
    actor, journal, actorContext: Context.pick(), canDrive: Effect.sync(() => canDrive),
    services: () => Job.layer(() => Effect.die(new Error("reply defect"))),
    onEvent: (event: RuntimeEvent<Event>) => { if (event.type === "EffectDied") canDrive = false },
    delivery: { address: { actor: "execution-defect", instance: "main", thread: "one" }, send: (message: MessageDelivery) => Effect.sync(() => {
      replies.push(message)
      return { id: message.id }
    }) },
  }
  let store = await Effect.runPromise(createActorStore(options))
  try {
    await Effect.runPromise(store.receive({ method: "run", input: "defect" }, {
      id: "remote", from: { actor: "caller", instance: "main", thread: "caller" },
    }))
    expect(await Effect.runPromise(Effect.flip(store.wait))).toBeInstanceOf(WatchdogTerminalError)
    expect(replies).toHaveLength(1)
    expect(replies[0]!.inReplyTo).toBe("remote")
    expect(replies[0]!.body).toMatchObject({ status: "failed" })
    expect(JSON.stringify(replies[0]!.body)).toContain("reply defect")
    expect([...store.snapshot().events].some(event => event.type === "MessageDelivered")).toBe(true)
    await Effect.runPromise(store.close)
    store = await Effect.runPromise(createActorStore(options))
    expect(await Effect.runPromise(Effect.flip(store.wait))).toBeInstanceOf(WatchdogTerminalError)
    expect(replies).toHaveLength(1)
  } finally {
    await Effect.runPromise(store.close)
    await Effect.runPromise(journal.close)
    await rm(storage, { recursive: true, force: true })
  }
})


test("a deferred producer death interrupts inline work and durably fails its caller", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-producer-death-"))
  const entered = Deferred.makeUnsafe<void>()
  const die = Deferred.makeUnsafe<void>()
  const Inline = act({ name: "test.death.inline", input: Schema.Null, success: Schema.Null, failure: Schema.String })
  const running = defineActor("producer-death", Effect.sync(() => {
    const producer = Job.request({ input: "defect" })
    const inline = Inline.request({ input: null })
    return { schema: Started, atom: effectAtom(get => ({ view: get(producer.result), events: {}, acts: { producer, inline } })),
      methods: { run: actorMethod({ inputSchema: Mode, outputSchema: Schema.String,
        onReceive: Started.from((mode, context) => ({ id: context.id, mode })), result: () => undefined,
      }) },
    }
  }))
  let aborted: AbortSignal | undefined
  const host = await Effect.runPromise(createBunHost({ actor: running, storage, actorContext: Context.pick(), services: () => Layer.mergeAll(
    Job.layer(() => Effect.gen(function* () {
      const execution = yield* EffectExecution
      const handle = yield* execution.fork(Deferred.await(die).pipe(Effect.andThen(Effect.die(new Error("producer died")))))
      return Job.defer(handle)
    }).pipe(Effect.mapError(error => ({ code: String(error) })))),
    Inline.layer((_, context) => { aborted = context.signal; return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }),
  ) }))
  try {
    const ref = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
    await Effect.runPromise(ref.invoke("run", "defect", { id: "producer" }))
    await Effect.runPromise(Deferred.await(entered))
    await Effect.runPromise(Deferred.succeed(die, undefined))
    expect(await Effect.runPromise(Effect.flip(ref.wait).pipe(Effect.timeout(2_000)))).toBeInstanceOf(WatchdogTerminalError)
    expect(aborted?.aborted).toBe(true)
    expect(await Effect.runPromise(ref.methodState("run", "producer"))).toMatchObject({ status: "failed", error: expect.stringContaining("producer died") })
    expect((await Effect.runPromise(ref.records())).filter(record => record.event.type === "EffectDied")).toHaveLength(1)
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})
