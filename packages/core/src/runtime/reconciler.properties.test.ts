import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import fc from "fast-check"
import {
  actorFromProjections,
  createActorReconciler,
  enabled,
  settleActor,
  type Actor
} from "./index"
import { component, cancelComponent, composeComponents, deriveComponent, transitionProjectionOf, type Component, type TransitionContext } from "../component"
import { actorRuntimeOf } from "./actor"
import { InvocationScope, OperationScope } from "./context"
import { EffectInterruptions, effectInterruptionRegistry } from "./reconciler"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { completeTransitionProjection, type CompleteTransitionDerivation, type Transition } from "@clavia/tardigrade-core/transition"
import { EventLog, withWatermark } from "../log"

const actorFromCompleteDerivations = <R = never>(
  derivations: ReadonlyArray<CompleteTransitionDerivation<R>>,
  keyOf: (event: Event) => string | undefined = () => undefined,
  cancellationOf?: Actor<R>["cancellationOf"],
  cancellationResiduals?: Actor<R>["cancellationResiduals"]
) => actorFromProjections({
  transitions: derivations.map(completeTransitionProjection),
  keyOf,
  ...(cancellationOf === undefined && cancellationResiduals === undefined
    ? {}
    : {
      legacy: {
        ...(cancellationOf === undefined ? {} : { cancellationOf }),
        ...(cancellationResiduals === undefined ? {} : { cancellationResiduals })
      }
    })
})

const memoryLog = (initial: ReadonlyArray<Event> = []) =>
  Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial)
      return withWatermark({
        append: (events: ReadonlyArray<Event>) => Ref.update(ref, (log) => [...log, ...events]),
        read: Ref.get(ref)
      })
    })
  )

describe("actor reconciliation", () => {
  test("distinct event owners settle independently with the same effect tag", async () => {
    const initial: ReadonlyArray<Event> = [
      { type: "Ignored" },
      { type: "Requested", owner: "first" },
      { type: "Requested", owner: "second" }
    ]
    const worker = component({
      name: "worker",
      initial: () => [] as ReadonlyArray<{ readonly owner: unknown; readonly ctx: TransitionContext }>,
      step: (pending, event, ctx) => event.type === "Requested" ? [...pending, { owner: event.owner, ctx }] : pending,
      output: (pending) => ({
        view: undefined,
        transitions: pending.map(({ owner, ctx }) => ctx.effect("execute", {
          input: owner,
          act: (input) => Effect.succeed({ type: "Completed", owner: input })
        }))
      })
    })
    const runtime = actorFromProjections({
      transitions: [transitionProjectionOf(worker)],
      keyOf: () => undefined
    })
    const events = await Effect.runPromise(Effect.gen(function* () {
      const log = yield* EventLog
      expect(enabled(runtime, yield* log.read)).toHaveLength(2)
      yield* settleActor(runtime)
      return yield* log.read
    }).pipe(Effect.provide(memoryLog(initial))))

    expect(events.filter((event) => event.type === "Completed").map((event) => event.owner))
      .toEqual(["first", "second"])
    expect(events.filter((event) => event.type === "Completed").map((event) => event.transitionRef))
      .toEqual([
        { seq: 2, component: "worker", tag: "execute" },
        { seq: 3, component: "worker", tag: "execute" }
      ])
  })

  test("a cancellation tombstone disables owned effects before or after arrival", () => {
    const invocation = { method: "work", id: "w1", epoch: 2 } as const
    const runtime = actorFromCompleteDerivations([() => [
      effect({ key: "owned", invocation, input: undefined, act: () => Effect.succeed([]) }),
      effect({ key: "other", invocation: { ...invocation, epoch: 3 }, input: undefined, act: () => Effect.succeed([]) })
    ]], () => undefined, (events, target) => events.some((event) =>
      event.type === "WorkStarted" &&
      String((event as { readonly id?: unknown }).id) === target.id &&
      Number((event as { readonly epoch?: unknown }).epoch) === target.epoch
    ) ? "running" : undefined)

    const started = { type: "WorkStarted", id: "w1", epoch: 2 } as Event
    const cancellation = { type: "CancellationRequested", request: "x1", invocation, cause: "requested" } as Event
    expect(enabled(runtime, [started, cancellation])
      .map((transition) => transition.key)).toEqual(["other"])
    expect(enabled(runtime, [cancellation, started])
      .map((transition) => transition.key)).toEqual(["other"])
  })

  test("cancellation residuals compose with actor continuations", () => {
    const invocation = { method: "work", id: "w1", epoch: 0 } as const
    const cleanup = effect({
      key: "cleanup",
      invocation,
      input: undefined,
      act: () => Effect.succeed([])
    })
    const runtime = actorFromCompleteDerivations(
      [() => [effect({ key: "ordinary", input: undefined, act: () => Effect.succeed([]) })]],
      () => undefined,
      () => "running",
      (events) => events.some((event) => event.type === "CancellationRequested") ? [cleanup] : undefined
    )

    expect(enabled(runtime, [{ type: "CancellationRequested" } as Event])
      .map((transition) => transition.key)).toEqual(["ordinary", "cleanup"])
    expect(enabled(runtime, [])
      .map((transition) => transition.key)).toEqual(["ordinary"])
  })

  test("independent cancellation effects start before either peer finishes", async () => {
    let started = 0
    let announceStarted: () => void = () => {}
    let release: () => void = () => {}
    const allStarted = new Promise<void>((resolve) => { announceStarted = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    const cleanup = (id: string) => effect({
      key: `cleanup:${id}`,
      input: id,
      act: (input) => Effect.promise(async () => {
        started += 1
        if (started === 2) announceStarted()
        await released
        return [{ type: "CleanupFinished", id: input } as Event]
      })
    })
    const runtime = actorFromCompleteDerivations(
      [],
      (event) => event.type === "CleanupFinished"
        ? `cleanup:${String((event as { readonly id?: unknown }).id)}`
        : undefined,
      undefined,
      () => [cleanup("one"), cleanup("two")]
    )
    const settling = Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memoryLog())))
    try {
      await Promise.race([
        allStarted,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cleanup effects started serially")), 1_000))
      ])
    } finally {
      release()
    }
    await settling
    expect(started).toBe(2)
  })

  test("a concurrent cancellation commit does not hide a wedged peer", async () => {
    const runtime = actorFromCompleteDerivations(
      [],
      (event) => event.type === "CleanupFinished"
        ? `cleanup:${String((event as { readonly id?: unknown }).id)}`
        : undefined,
      undefined,
      () => [
        effect({
          key: "cleanup:good",
          input: undefined,
          act: () => Effect.succeed([{ type: "CleanupFinished", id: "good" } as Event])
        }),
        effect({
          key: "cleanup:missing",
          input: undefined,
          act: () => Effect.succeed([{ type: "UnkeyedCleanup" } as Event])
        })
      ]
    )
    await expect(Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memoryLog()))))
      .rejects.toThrow('effect "cleanup:missing" wedged')
  })

  test("a committed intent invalidates every remaining transition from its snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 20 }), async (siblings) => {
        const projection: CompleteTransitionDerivation = (log) => {
          if (log.some((event) => event.type === "SnapshotAdvanced")) return []
          return [
            intent({
              key: "advance",
              input: undefined,
              events: (_input, at) => [{ type: "SnapshotAdvanced", at }]
            }),
            ...Array.from({ length: siblings }, (_, index) =>
              effect({
                key: `stale:${index}`,
                input: index,
                act: (input) => Effect.succeed([{ type: "StaleCommitted", id: input }])
              })
            )
          ]
        }
        const runtime = actorFromCompleteDerivations([projection], (event) => {
          if (event.type === "SnapshotAdvanced") return "advance"
          if (event.type === "StaleCommitted") return `stale:${String((event as { id?: unknown }).id)}`
          return undefined
        })
        const settled = Effect.gen(function* () {
          yield* settleActor(runtime)
          return yield* Effect.flatMap(EventLog, (log) => log.read)
        })
        const log = await Effect.runPromise(settled.pipe(Effect.provide(memoryLog())))

        expect(log).toHaveLength(1)
        expect(log[0]).toMatchObject({ type: "SnapshotAdvanced" })
        expect(Number((log[0] as { at?: unknown }).at)).toBeGreaterThan(0)
      }),
      { numRuns: 100 }
    )
  })
})

interface TestTransitionContext extends TransitionContext {
  readonly result: (tag: string) => Option.Option<Event>
}

const taggedComponent = <Input, R = never>(definition: {
  readonly name: string
  readonly select: (event: Event) => Input | undefined
  readonly derive: (input: Input, ctx: TestTransitionContext) => ReadonlyArray<Transition<never, R>>
}) => component({
  name: definition.name,
  initial: () => ({
    owners: [] as ReadonlyArray<{ readonly input: Input; readonly ctx: TransitionContext }>,
    events: [] as ReadonlyArray<Event>
  }),
  step: (state, event, ctx) => {
    const input = definition.select(event)
    return {
      owners: input === undefined ? state.owners : [...state.owners, { input, ctx }],
      events: [...state.events, event]
    }
  },
  output: (state) => ({
    view: undefined,
    transitions: state.owners.flatMap(({ input, ctx }) => definition.derive(input, {
      ...ctx,
      result: (tag) => {
        const found = state.events.find((event) => ctx.matches(tag, event))
        return found === undefined ? Option.none() : Option.some(found)
      }
    }))
  })
})

const memory = (events: Event[]) => Layer.succeed(EventLog, withWatermark({
  read: Effect.sync(() => [...events]),
  append: (tail) => Effect.sync(() => { events.push(...tail) })
}))

const runtimeOf = <R>(...components: ReadonlyArray<Component<undefined, R>>) => ({
  projections: components.map(transitionProjectionOf),
  keyOf: () => undefined
})

test("component identity and full log position distinguish equal tags and provider IDs", async () => {
  const events: Event[] = [{ type: "Unrelated" }, { type: "Requested", callId: "7" }, { type: "Requested", callId: "7" }]
  const worker = (name: string) => taggedComponent({
    name,
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [ctx.effect("execute", { input: name, act: (input) => Effect.succeed({ type: "Executed", result: input }) })]
  })
  const runtime = runtimeOf(worker("a"), worker("b"))
  await Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memory(events))))
  expect(events.slice(3).map((event) => event.type)).toEqual(["Executed", "Executed", "Executed", "Executed"])
  expect(events.slice(3).map((event) => event.transitionRef)).toEqual([
    { seq: 2, component: "a", tag: "execute" },
    { seq: 3, component: "a", tag: "execute" },
    { seq: 2, component: "b", tag: "execute" },
    { seq: 3, component: "b", tag: "execute" }
  ])
})

test("remaining transitions keep their tags through failure and cold replay", async () => {
  const events: Event[] = [{ type: "Requested" }]
  const attempts: string[] = []
  let fail = true
  const worker = () => taggedComponent({
    name: "files",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [
      ...(Option.isNone(ctx.result("download")) ? [ctx.effect("download", {
        input: "bytes",
        act: (input) => Effect.sync(() => { attempts.push("download"); return { type: "Downloaded", contents: input } })
      })] : []),
      ctx.effect("upload", {
        input: ctx.result("download"),
        act: (input) => Effect.gen(function* () {
          attempts.push("upload")
          if (fail) return yield* Effect.die(new Error("connection lost"))
          return { type: "Uploaded", contents: Option.getOrThrow(input).contents }
        })
      })
    ]
  })
  await expect(Effect.runPromise(settleActor(runtimeOf(worker())).pipe(Effect.provide(memory(events)))))
    .rejects.toThrow("connection lost")
  const pendingKey = enabled(runtimeOf(worker()), events)[0]!.key
  fail = false
  await Effect.runPromise(settleActor(runtimeOf(worker())).pipe(Effect.provide(memory(events))))
  expect(attempts).toEqual(["download", "upload", "upload"])
  expect(events.at(-1)).toMatchObject({ type: "Uploaded", transitionRef: { seq: 1, component: "files", tag: "upload" }, contents: "bytes" })
  expect(actorRuntimeOf(runtimeOf(worker())).keyOf(events.at(-1)!)).toBe(pendingKey)
  await Effect.runPromise(settleActor(runtimeOf(worker())).pipe(Effect.provide(memory(events))))
  expect(attempts).toHaveLength(3)
})

test("duplicate tags fail before dispatch, including effect and intent collisions", async () => {
  let dispatched = false
  const worker = taggedComponent({
    name: "worker",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [
      ctx.effect("execute", { input: undefined, act: () => Effect.sync(() => { dispatched = true; return { type: "Executed" } }) }),
      ctx.intent("execute", { type: "Executed" })
    ]
  })
  await expect(Effect.runPromise(settleActor(runtimeOf(worker)).pipe(Effect.provide(memory([{ type: "Requested" }])))))
    .rejects.toThrow("duplicate transition tag")
  expect(dispatched).toBe(false)
})

test("duplicate component identity identities are rejected across composition", () => {
  const worker = () => taggedComponent({ name: "same", select: () => undefined, derive: () => [] })
  const algebra = { empty: undefined, combine: () => undefined }
  const nested = composeComponents("nested", algebra, [worker()])
  expect(() => composeComponents("root", algebra, [nested, worker()])).toThrow("duplicate component identity")
  expect(() => actorRuntimeOf(runtimeOf(worker(), worker()))).toThrow("duplicate component identity")
  expect(() => actorRuntimeOf({ name: "root", methods: {}, components: [nested, worker()] })).toThrow("duplicate component identity")
  expect(() => deriveComponent(taggedComponent({ name: "", select: () => undefined, derive: () => [] }), [])).toThrow()
})

test("completion identity is attached without changing or mutating the domain event", async () => {
  const completion = { type: "ToolReturned", callId: "7", result: { value: 42 } }
  const events: Event[] = [{ type: "Requested" }]
  const worker = taggedComponent({
    name: "tools",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [ctx.effect("execute", { input: undefined, act: () => Effect.succeed(completion) })]
  })
  await Effect.runPromise(settleActor(runtimeOf(worker)).pipe(Effect.provide(memory(events))))
  expect(events).toEqual([
    { type: "Requested" },
    { ...completion, transitionRef: { seq: 1, component: "tools", tag: "execute" } }
  ])
  expect(completion).not.toHaveProperty("transitionRef")
})

test("a completion cannot claim a different work reference", async () => {
  const events: Event[] = [{ type: "Requested" }]
  const worker = taggedComponent({
    name: "tools",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [ctx.intent("execute", {
      type: "ToolReturned", transitionRef: { seq: 2, component: "other", tag: "execute" }
    })]
  })
  await expect(Effect.runPromise(settleActor(runtimeOf(worker)).pipe(Effect.provide(memory(events)))))
    .rejects.toThrow("already carries a transition reference")
  expect(events).toEqual([{ type: "Requested" }])
})

// taggedTransitionContract checks that authors supply local tags without constructing identity.
export const taggedTransitionContract = (ctx: TransitionContext): void => {
  ctx.effect("execute", { input: "value", act: (value) => Effect.succeed({ type: "Completed", value }) })
  // @ts-expect-error the runtime supplies transition keys
  ctx.effect("execute", { key: "custom", input: undefined, act: () => Effect.succeed({ type: "Completed" }) })
  // @ts-expect-error the runtime supplies ownership references
  ctx.effect("execute", { ref: { seq: 1 }, input: undefined, act: () => Effect.succeed({ type: "Completed" }) })
  // @ts-expect-error local tags are required
  ctx.effect({ input: undefined, act: () => Effect.succeed({ type: "Completed" }) })
  // @ts-expect-error actions return their domain completion event
  ctx.effect("execute", { input: undefined, act: () => Effect.succeed(1) })
  // @ts-expect-error intents supply their domain completion event
  ctx.intent("execute", "done")
}

test("complete component replay supplies positions and rejects unpositioned tagged transitions", () => {
  const worker = component({
    name: "worker",
    initial: (): TransitionContext | undefined => undefined,
    step: (state, event, ctx) => event.type === "Requested" ? ctx : state,
    output: (ctx) => ({ view: undefined, transitions: ctx === undefined ? [] : [ctx.intent("execute", { type: "Executed" })] })
  })
  const events: ReadonlyArray<Event> = [{ type: "Ignored" }, { type: "Requested" }]
  const runtimeKey = enabled(runtimeOf(worker), events)[0]!.key
  expect(deriveComponent(worker, events).transitions[0]!.key).toBe(runtimeKey)
  expect(() => worker.machine.step(worker.machine.initial(), { type: "Requested" }))
    .toThrow("recorded event position")
})

const localIdentity = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.constantFrom("a:b", "a,b", '["a"]', "a/b", "1")
)

test("tag-only declarations preserve identity, completion correlation, and replay", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(localIdentity, { minLength: 2, maxLength: 3 }),
    fc.uniqueArray(fc.record({ tag: localIdentity, isIntent: fc.boolean() }), {
      minLength: 2, maxLength: 4, selector: (spec) => spec.tag
    }),
    fc.array(fc.record({ noise: fc.integer({ min: 0, max: 3 }), cold: fc.boolean() }), { minLength: 2, maxLength: 4 }),
    async (names, tags, batches) => {
      const events: Event[] = []
      const calls: Event[] = []
      const expected: Event[] = []
      const expectedCalls: Event[] = []
      const sorted = (values: ReadonlyArray<Event>) => values.map((value) => JSON.stringify(value)).sort()
      const makeRuntime = (reverse = false) => runtimeOf(...(reverse ? [...names].reverse() : names).map((name) => component({
        name,
        initial: () => [] as ReadonlyArray<{ request: unknown; ctx: TransitionContext; remaining: typeof tags }>,
        step: (state, event, ctx) => event.type === "Requested"
          ? [...state, { request: event.request, ctx, remaining: tags }]
          : state.map((owner) => ({
            ...owner,
            remaining: owner.remaining.filter(({ tag }) => !owner.ctx.matches(tag, event))
          })).filter((owner) => owner.remaining.length > 0),
        output: (state) => ({
          view: undefined,
          transitions: state.flatMap(({ request, ctx, remaining }) =>
            (remaining.length % 2 === 0 ? [...remaining].reverse() : remaining).map(({ tag, isIntent }) => {
              const completion = { type: "Completed", request, producer: name, tag, callId: "7" }
              return isIntent ? ctx.intent(tag, completion) : ctx.effect(tag, {
                input: completion,
                act: (input) => Effect.sync(() => { calls.push(input); return input })
              })
            }))
        })
      })))
      const retained = createActorReconciler(makeRuntime())
      for (const [batchIndex, batch] of batches.entries()) {
        events.push(...Array.from({ length: batch.noise }, () => ({ type: "Unrelated" })))
        for (let offset = 0; offset < 2; offset++) {
          const request = batchIndex * 2 + offset
          events.push({ type: "Requested", request, callId: "7" })
          const seq = events.length
          for (const name of names) {
            for (const { tag, isIntent } of tags) {
              const completion = { type: "Completed", request, producer: name, tag, callId: "7" }
              expected.push({ ...completion, transitionRef: { seq, component: name, tag } })
              if (!isIntent) expectedCalls.push(completion)
            }
          }
        }
        await Effect.runPromise((batch.cold ? settleActor(makeRuntime(true)) : retained.settle).pipe(Effect.provide(memory(events))))
        expect(sorted(events.filter((event) => event.type === "Completed"))).toEqual(sorted(expected))
        expect(sorted(calls)).toEqual(sorted(expectedCalls))
        expect(enabled(makeRuntime(), events)).toEqual([])
      }
      const replayed: Event[] = JSON.parse(JSON.stringify(events))
      await Effect.runPromise(settleActor(makeRuntime(true)).pipe(Effect.provide(memory(replayed))))
      expect(replayed).toEqual(events)
      expect(sorted(calls)).toEqual(sorted(expectedCalls))
    }
  ), { numRuns: 100 })
})

test("tag-only declarations reject duplicate local tags before dispatch", async () => {
  await fc.assert(fc.asyncProperty(localIdentity, localIdentity, fc.boolean(), async (name, tag, isIntent) => {
    const events: Event[] = [{ type: "Requested" }]
    let calls = 0
    const worker = taggedComponent({
      name,
      select: (event) => event.type === "Requested" ? event : undefined,
      derive: (_input, ctx) => {
        const declare = () => ctx.effect(tag, {
          input: undefined,
          act: () => Effect.sync(() => { calls++; return { type: "Completed" } })
        })
        return [declare(), isIntent ? ctx.intent(tag, { type: "Completed" }) : declare()]
      }
    })
    await expect(Effect.runPromise(settleActor(runtimeOf(worker)).pipe(Effect.provide(memory(events)))))
      .rejects.toThrow("duplicate transition tag")
    expect(calls).toBe(0)
    expect(events).toEqual([{ type: "Requested" }])
  }), { numRuns: 100 })
})


test("components reject manual transitions in output and cancellation", () => {
  const manual = [
    intent({ key: "manual", input: undefined, events: () => [{ type: "Completed" }] }),
    effect({ key: "manual", input: undefined, act: () => Effect.succeed([{ type: "Completed" }]) })
  ]
  for (const transition of manual) {
    for (const cancellation of [false, true]) {
      const worker = component({
        name: "worker",
        initial: () => false,
        step: () => true,
        output: (ready) => ({ view: undefined, transitions: ready && !cancellation ? [transition] : [] }),
        cancelState: () => [transition]
      })
      const events = [{ type: "Requested" }]
      expect(() => cancellation
        ? cancelComponent(worker, events, { request: "stop", invocation: { method: "run", id: "1", epoch: 0 }, cause: "requested" })
        : enabled(runtimeOf(worker), events)).toThrow('component "worker" requires transitions declared through its context')
    }
  }
})

test("components reject transitions from another component context", () => {
  const source = taggedComponent({
    name: "source",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_input, ctx) => [ctx.intent("execute", { type: "Completed" })]
  })
  const events = [{ type: "Requested" }]
  const borrowed = deriveComponent(source, events).transitions
  const other = component({
    name: "other",
    initial: () => false,
    step: () => true,
    output: (ready) => ({ view: undefined, transitions: ready ? borrowed : [] })
  })
  expect(() => enabled(runtimeOf(other), events)).toThrow('transition belongs to component "source", not "other"')
})

test("cancellation validates the shared intent and effect tag namespace", () => {
  const worker = component({
    name: "worker",
    initial: (): TransitionContext | undefined => undefined,
    step: (_state, _event, ctx) => ctx,
    output: () => ({ view: undefined, transitions: [] }),
    cancelState: (ctx) => ctx === undefined ? [] : [
      ctx.intent("stop", { type: "Stopped" }),
      ctx.effect("stop", { input: undefined, act: () => Effect.succeed({ type: "Stopped" }) })
    ]
  })
  expect(() => cancelComponent(worker, [{ type: "Requested" }], {
    request: "stop", invocation: { method: "run", id: "1", epoch: 0 }, cause: "requested"
  })).toThrow("duplicate transition tag")
})


test("tagged transitions inherit invocation ownership through completions and replay", async () => {
  const invocation = { method: "run", id: "one", epoch: 2 }
  const call = { invocation, parent: { method: "parent", id: "p", epoch: 0 }, deadlineAt: 1000 }
  const events: Event[] = [{ type: "Requested", call }]
  const observed: unknown[] = []
  const worker = () => taggedComponent({
    name: "worker",
    select: (event) => event.type === "Requested" || event.type === "Dispatched" ? event : undefined,
    derive: (event, ctx) => event.type === "Requested"
      ? [ctx.intent("dispatch", { type: "Dispatched" })]
      : [ctx.effect("execute", {
        input: undefined,
        act: () => Effect.gen(function* () {
          const scope = yield* Effect.serviceOption(InvocationScope)
          observed.push(Option.isSome(scope) ? scope.value.context : undefined)
          expect(Option.getOrUndefined(yield* Effect.serviceOption(OperationScope))).toEqual({
            type: "transition", ref: { seq: 2, component: "worker", tag: "execute" }
          })
          return { type: "Completed" }
        })
      })]
  })
  expect(enabled(runtimeOf(worker()), events)[0]!.invocation).toEqual(invocation)
  await Effect.runPromise(settleActor(runtimeOf(worker())).pipe(Effect.provide(memory(events))))
  expect(observed).toEqual([call])
  expect(events.slice(1).map((event) => event.invocationRef)).toEqual([invocation, invocation])
  const replayed: Event[] = JSON.parse(JSON.stringify(events))
  await Effect.runPromise(settleActor(runtimeOf(worker())).pipe(Effect.provide(memory(replayed))))
  expect(replayed).toEqual(events)
  expect(observed).toHaveLength(1)
})

test("tagged invocation effects observe live cancellation and discard their result", async () => {
  const invocation = { method: "run", id: "one", epoch: 2 }
  const events: Event[] = [{ type: "Requested", call: { invocation } }]
  const registry = effectInterruptionRegistry()
  const signals: boolean[] = []
  const worker = taggedComponent({
    name: "worker",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_event, ctx) => [ctx.effect("execute", {
      input: undefined,
      act: (_input, { signal }) => Effect.gen(function* () {
        const log = yield* EventLog
        const other = { type: "CancellationRequested", request: "other", invocation: { ...invocation, epoch: 3 }, cause: "requested" }
        yield* log.append([other])
        registry.interrupt([other])
        signals.push(signal.aborted)
        const own = { type: "CancellationRequested", request: "own", invocation, cause: "requested" }
        yield* log.append([own])
        registry.interrupt([own])
        signals.push(signal.aborted)
        return { type: "Completed" }
      })
    })]
  })
  const runtime = { ...runtimeOf(worker), cancellationOf: () => "running" as const }
  await Effect.runPromise(settleActor(runtime).pipe(
    Effect.provide(memory(events)), Effect.provideService(EffectInterruptions, registry)
  ))
  expect(signals).toEqual([false, true])
  expect(events.some((event) => event.type === "Completed")).toBe(false)
})

test("tagged effect declarations preserve explicit invocation and interruption options", () => {
  const invocation = { method: "run", id: "one", epoch: 0 }
  const interrupts = (_input: undefined, event: Event) => event.type === "Invalidated"
  const options = { invocation, interrupts, concurrent: true, input: undefined, act: () => Effect.succeed({ type: "Completed" }) }
  const worker = taggedComponent({
    name: "worker",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_event, ctx) => [ctx.effect("execute", options)]
  })
  const transition = enabled(runtimeOf(worker), [{ type: "Requested" }])[0]!
  expect(transition.invocation).toEqual(invocation)
  expect(transition.kind === "effect" && transition.interrupts).toBe(interrupts)
  expect(transition.kind === "effect" && transition.concurrent).toBe(true)
})


test("tagged transitions reject conflicting invocation ownership", async () => {
  const invocation = { method: "run", id: "one", epoch: 0 }
  const other = { ...invocation, epoch: 1 }
  const events: Event[] = [{ type: "Requested", call: { invocation } }]
  for (const isIntent of [false, true]) {
    const worker = taggedComponent({
      name: "worker",
      select: (event) => event.type === "Requested" ? event : undefined,
      derive: (_event, ctx) => [isIntent
        ? ctx.intent("execute", { type: "Completed" }, { invocation: other })
        : ctx.effect("execute", { invocation: other, input: undefined, act: () => Effect.succeed({ type: "Completed" }) })]
    })
    expect(() => enabled(runtimeOf(worker), events)).toThrow("transition invocation conflicts with its owning event")
  }
  const worker = taggedComponent({
    name: "worker",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_event, ctx) => [ctx.intent("execute", { type: "Completed", invocationRef: other })]
  })
  await expect(Effect.runPromise(settleActor(runtimeOf(worker)).pipe(Effect.provide(memory(events)))))
    .rejects.toThrow("completion event already carries an invocation reference")
  expect(events).toHaveLength(1)
})


test("explicitly detached control transitions finish after invocation cancellation", async () => {
  const invocation = { method: "run", id: "one", epoch: 0 }
  const events: Event[] = [
    { type: "Requested", call: { invocation } },
    { type: "CancellationRequested", request: "stop", invocation, cause: "requested" }
  ]
  const worker = taggedComponent({
    name: "control",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_event, ctx) => [ctx.effect("deliver", {
      invocation: null,
      input: undefined,
      act: () => Effect.gen(function* () {
        expect(Option.isNone(yield* Effect.serviceOption(InvocationScope))).toBe(true)
        return { type: "Delivered" }
      })
    })]
  })
  const runtime = { ...runtimeOf(worker), cancellationOf: () => "running" as const }
  expect(enabled(runtime, events)[0]!.invocation).toBeUndefined()
  await Effect.runPromise(settleActor(runtime).pipe(Effect.provide(memory(events))))
  expect(events.at(-1)).toEqual({ type: "Delivered", transitionRef: { seq: 1, component: "control", tag: "deliver" } })
})

test("tagged intents construct domain events at commit time", () => {
  const worker = taggedComponent({
    name: "control",
    select: (event) => event.type === "Requested" ? event : undefined,
    derive: (_event, ctx) => [ctx.intent("deliver", (at) => ({ type: "Delivered", at }), { invocation: null })]
  })
  const transition = enabled(runtimeOf(worker), [{ type: "Requested" }])[0]!
  expect(transition.kind).toBe("intent")
  if (transition.kind !== "intent") return
  expect(transition.events(transition.input, 123)).toEqual([
    { type: "Delivered", at: 123, transitionRef: { seq: 1, component: "control", tag: "deliver" } }
  ])
})
