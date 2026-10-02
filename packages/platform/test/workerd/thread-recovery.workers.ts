import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { expect, test } from "vitest"
import { Context, Deferred, Effect, Schema } from "effect"
import { act, actorMethod, defineActor, durableAtom, effectAtom, event, watchdogKey } from "@clavia/tardigrade-core"
import { createCloudflareHost } from "../../src/cloudflare"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER

test("pending thread references survive watchdog invalidation and explicit resume", async () => {
  await runInDurableObject(namespace.getByName("reference-watchdog-recovery"), async (_instance, state) => {
    const Started = event({ type: "Started" })
    const Finished = event({ type: "Finished" })
    const Event = Schema.Union([Started, Finished])
    const Job = act({ name: "reference.job", input: Schema.Null, success: Schema.Null, failure: Schema.String })
    const actor = defineActor("reference", Effect.sync(() => {
      const progress = durableAtom({ name: "reference", input: Event, schema: Schema.Struct({ started: Schema.Boolean, done: Schema.Boolean }), initial: { started: false, done: false }, reduce: (s, e) => e.type === "Started" ? { ...s, started: true } : { ...s, done: true } })
      const request = Job.request({ tag: "job", input: null, onSettled: () => [Finished.make({})] })
      return { atom: effectAtom(get => { const view = get(progress); return { view, events: {}, acts: view.started && !view.done ? { job: request } : {} } }), methods: { start: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.Boolean, onReceive: Started.from(() => ({})), result: (_, get) => get(progress).done ? { status: "completed" as const, output: true } : undefined }) } }
    }))
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let executions = 0
    let allowSuccess = false
    const host = createCloudflareHost({ actor, storage: state.storage, actorContext: Context.pick(), services: () => Job.layer(() => Effect.gen(function* () {
      executions++
      if (!allowSuccess) {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* Effect.die(new Error("injected runtime defect"))
      }
      return null
    })) })
    const target = { actor: "reference", instance: "main", thread: "one" }
    try {
      const thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "one" }))
      await Effect.runPromise(thread.invoke("start", null, { id: "message" }))
      await Effect.runPromise(Deferred.await(entered))
      const result = Effect.runPromise(thread.result("start", "message").pipe(Effect.timeout(2_000)))
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await expect(Effect.runPromise(thread.wait)).rejects.toThrow()
      await Effect.runPromise(host.alarm)
      await Effect.runPromise(Effect.gen(function* () {
        while ((yield* host.watchdog.status).get(watchdogKey(target))?.status !== "blocked") yield* Effect.sleep(1)
      }).pipe(Effect.timeout(1_000)))
      const attemptsBeforeResume = executions
      allowSuccess = true
      await Effect.runPromise(host.watchdog.resume(target))
      await Effect.runPromise(host.alarm)
      expect(await result).toEqual({ status: "completed", output: true })
      await Effect.runPromise(thread.wait)
      expect(executions).toBe(attemptsBeforeResume + 1)
      expect(thread.getState().view.done).toBe(true)
      expect(await Effect.runPromise(thread.invoke("start", null, { id: "after-recovery" }))).toMatchObject({ id: "after-recovery" })
    } finally { await Effect.runPromise(host.close) }
  })
})
