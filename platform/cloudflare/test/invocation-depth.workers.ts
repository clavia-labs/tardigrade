import { AsyncLocalStorage } from "node:async_hooks"
import { env, runInDurableObject } from "cloudflare:test"
import { Effect } from "effect"
import { expect, test, vi } from "vitest"
import { actor, component } from "@clavia/tardigrade-core/actor"
import { threadSupervisor } from "@clavia/tardigrade-core/actor/supervisor"
import type { Event } from "@clavia/tardigrade-core/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Self, settleActor } from "@clavia/tardigrade-core/runtime"
import { Router } from "@clavia/tardigrade-core/transport/router"
import type { TransitionContext } from "@clavia/tardigrade-core/transition/transition"
import { createThreadDriver, hostDrive } from "@clavia/tardigrade-host/driver"
import { ThreadDO } from "../src/thread"
import { mountedActor } from "../src/assembly"
import type { Env } from "../src/env"

// InvocationDepth models RPC ancestry and independent alarm dispatch; the limit is synthetic.
class InvocationDepth {
  private readonly context = new AsyncLocalStorage<number>()
  readonly exceeded: number[] = []
  maximum = 0
  constructor(readonly limit: number) {}
  current(): number { return this.context.getStore() ?? 0 }
  fresh<A>(run: () => A): A { return this.context.run(0, run) }
  async rpc<A>(run: () => Promise<A>): Promise<A> {
    const depth = this.current() + 1
    this.maximum = Math.max(this.maximum, depth)
    if (depth > this.limit) {
      this.exceeded.push(depth)
      throw new Error(`Simulated invocation depth exceeded: ${depth} > ${this.limit}`)
    }
    return this.context.run(depth, run)
  }
}

test("depth counts async ancestry, not sibling calls, and alarms start fresh", async () => {
  const depth = new InvocationDepth(2)
  await depth.fresh(() => Promise.all(Array.from({ length: 20 }, () => depth.rpc(async () => {
    await Promise.resolve()
    expect(depth.current()).toBe(1)
    await depth.rpc(async () => { expect(depth.current()).toBe(2) })
  }))))
  expect(depth.maximum).toBe(2)
  expect(depth.exceeded).toEqual([])
  await expect(depth.rpc(() => depth.rpc(() => depth.rpc(async () => {}))))
    .rejects.toThrow("Simulated invocation depth exceeded: 3 > 2")
  await depth.rpc(() => depth.fresh(async () => { expect(depth.current()).toBe(0) }))
})

test.each([3, 20])("%i nested thread effects and replies complete within the invocation depth budget", async (count) => {
  const depth = new InvocationDepth(8)
  const alarms = new Map<number, number>()
  const background = new Set<Promise<unknown>>()
  const histories: Event[][] = Array.from({ length: count }, () => [])
  const threads: ThreadDO[] = []
  let output: number | undefined
  const errors = vi.spyOn(console, "error").mockImplementation(() => {})
  const send = async (index: number, event: Event): Promise<void> => {
    for (;;) {
      const result = await depth.rpc(() => threads[index]!.appendAt([event], histories[index]!.length))
      if (result.appended > 0) return
    }
  }
  const retain = (task: Promise<unknown>) => {
    background.add(task)
    void task.then(() => background.delete(task), () => background.delete(task))
  }
  try {
    for (let index = 0; index < count; index++) {
      const events = histories[index]!
      const definition = actor({
        name: "chain",
        methods: {},
        components: [component({
          name: "chain",
          initial: () => new Map<string, { event: Event; context: TransitionContext }>(),
          step: (pending, event, context) => {
            const next = new Map(pending)
            if (event.type === "Start" || event.type === "ChildReply") next.set(event.type, { event, context })
            if (event.type === "StepCompleted") next.delete(String(event.id))
            return next
          },
          output: (pending) => ({
            view: undefined,
            transitions: [...pending.values()].map(({ event, context }) => context.effect("continue", {
              input: event,
              act: (input) => Effect.promise(async () => {
                if (input.type === "Start" && index < count - 1) {
                  await send(index + 1, { type: "Start", at: 1 })
                } else {
                  const value = input.type === "Start" ? 1 : Number(input.value) + 1
                  if (index === 0) output = value
                  else await send(index - 1, { type: "ChildReply", value, at: 1 })
                }
                return { type: "StepCompleted", id: input.type, at: 1 }
              })
            }))
          })
        })]
      })
      const log = withWatermark({
        read: Effect.sync(() => [...events]),
        append: (batch) => Effect.sync(() => { events.push(...batch) })
      })
      const driver = createThreadDriver({
        serve: () => Effect.runPromise(settleActor(definition).pipe(
          Effect.provideService(EventLog, log),
          Effect.provideService(Self, { actor: "chain", instance: "main", thread: String(index) }),
          Effect.provideService(Router, { send: () => Effect.die(new Error("unexpected routing")) })
        ))
      })
      const { drive } = hostDrive(() => driver.drain())
      const host = {
        read: async () => [...events],
        appendAt: async (batch: ReadonlyArray<Event>, head: number) => {
          if (events.length !== head) return { appended: 0, head: events.length }
          events.push(...batch)
          driver.mark(String(index))
          return { appended: batch.length, head: events.length }
        },
        publishStaged: () => {},
        drive,
        recover: async () => { driver.mark(String(index)); await drive() },
        recordAlarm: async () => {},
        resting: async () => driver.resting(),
        work: driver.work,
        nextMethodDeadline: async () => undefined,
        nextAlarmDeadline: async () => undefined
      }
      const storage = {
        sql: { exec: () => ({ toArray: () => [{ actor: "chain", instance: "main", thread: String(index) }] }) },
        get: async () => true,
        getAlarm: async () => alarms.get(index) ?? null,
        setAlarm: async (at: number) => { alarms.set(index, at) },
        deleteAlarm: async () => { alarms.delete(index) },
        sync: async () => {}
      }
      const thread: ThreadDO = Object.assign(Object.create(ThreadDO.prototype), {
        ctx: { storage, waitUntil: retain },
        env: { ACTORS: { getByName: () => ({ ensureThreadReady: async () => {} }) } },
        runtime: Promise.resolve(host),
        alarmPolicy: { recoveryDelayMillis: 60_000 },
        backgroundTaskOwner: "request"
      })
      threads.push(thread)
    }
    await depth.fresh(() => send(0, { type: "Start", at: 1 }))
    for (let pass = 0; pass < count * 4; pass++) {
      while (background.size > 0) await Promise.all(background)
      const due = [...alarms].find(([, at]) => at <= Date.now())
      if (due === undefined) break
      const [index] = due
      alarms.delete(index)
      await depth.fresh(() => threads[index]!.alarm())
    }
    expect(depth.exceeded, "execution must leave the incoming RPC chain").toEqual([])
    expect(errors).not.toHaveBeenCalled()
    expect(output).toBe(count)
    expect(depth.maximum).toBeLessThanOrEqual(depth.limit)
    expect(histories.map((events) => events.filter((event) => event.type === "Start").length)).toEqual(Array(count).fill(1))
    expect(histories.map((events) => events.filter((event) => event.type === "ChildReply").length))
      .toEqual([...Array(count - 1).fill(1), 0])
    expect(alarms.size).toBe(0)
  } finally {
    errors.mockRestore()
  }
})

test("supervisor setup runs outside the allocation RPC and completes before allocation returns", async () => {
  const depth = new InvocationDepth(8)
  const directory = (env as Env).ACTORS.getByName(JSON.stringify(["echo", "invocation-depth"]))
  await directory.init("echo", "invocation-depth")
  const setupDepths: number[] = []
  await runInDurableObject(directory, async (instance, state) => {
    const previous = mountedActor!.supervisor
    try {
      Reflect.set(mountedActor!, "supervisor", threadSupervisor({ setup: () => Effect.sync(() => {
        setupDepths.push(depth.current())
      }) }))
      const target = await depth.rpc(() => instance.createThread("root"))
      expect(target).toEqual({ actor: "echo", instance: "invocation-depth", thread: "root" })
      const events = state.storage.sql.exec<{ event: string }>("SELECT event FROM events ORDER BY seq")
        .toArray().map((row) => JSON.parse(row.event) as Event)
      expect(events.map((event) => event.type)).toEqual(["ThreadRequested", "ThreadRegistered"])
      expect(setupDepths, "setup must execute in an independent alarm invocation").toEqual([0])
    } finally {
      Reflect.set(mountedActor!, "supervisor", previous)
    }
  })
})
