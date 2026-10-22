import { journalCall } from "@clavia/tardigrade-core"
import { completionState } from "../completion-state"
import { effectServiceClient, type EffectServicePolicy } from "../effect-service"
import { waitFor } from "../wait"
export { EffectServiceDO } from "./effect-service.worker"
export { LayoutActorDO, LayoutThreadDO } from "./layout-fixture"
export { RetryActorDO, RetryThreadDO } from "./retry-fixture.worker"
export { SlowActorDO, SlowThreadDO } from "./slow-act-fixture.worker"
import layout from "./layout-fixture"
import { retryFetch } from "./retry-fixture.worker"
import { slowFetch } from "./slow-act-fixture.worker"

export default { fetch: (request: Request, env: Parameters<typeof retryFetch>[1] & Parameters<typeof slowFetch>[1] & Parameters<typeof layout.fetch>[1]) => {
  const path = new URL(request.url).pathname
  return path.startsWith("/v1/actors/retry-direct-") ? retryFetch(request, env) : path.startsWith("/v1/actors/watchdog-slow-") ? slowFetch(request, env) : layout.fetch(request, env)
},
}
import { DurableObject } from "cloudflare:workers"

export class TestPromiseResolver extends DurableObject { alarm(): Promise<void> { return Promise.resolve() } }

import { Context, Effect, Layer, Schema } from "effect"
import { act, createActorStore, defineActor, effectAtom, Promises, RuntimeError, Scheduler, createWatchdog, createScheduler, effectKey, type EffectRef, type WatchdogEntry } from "@clavia/tardigrade-core"
import { objectJournal } from "../../../src/cloudflare/objects"
import { cloudflareWatchdogStorage } from "../../../src/cloudflare/watchdog"
import { cloudflareSchedulerStorage } from "../../../src/cloudflare/scheduler"

const NativeJob = act({ name: "native-input", input: Schema.String, success: Schema.String, failure: Schema.String })
const completion = completionState("native.completion", Schema.String)
const NativeEvent = Schema.Union([Schema.Struct({ type: Schema.Literal("Unused") }), completion.event])
type NativeConfig = { readonly input: string; readonly mode: "pending" | "deferred" | "complete"; readonly cleanup: "retry" | "success"; readonly attemptTimeoutMs?: number | null }
const nativeTarget = { actor: "native-input", instance: "main", thread: "one" }
const nativeRecoveryPolicy = { attemptTimeoutMs: 1_000, keepAliveIntervalMs: 250, retryIntervalMs: 250, maxRetryIntervalMs: 250 }
type NativeCall = { readonly kind: "execution" | "cleanup"; readonly input: string; readonly ref: EffectRef; readonly instance: string }

export class InputLifecycleDO extends DurableObject<{ EFFECT_SERVICE: { getByName(name: string): { fetch(request: Request): Promise<Response> } } }> {
  private readonly external = effectServiceClient(request => this.env.EFFECT_SERVICE.getByName(this.ctx.id.toString()).fetch(request))
  private readonly instance = crypto.randomUUID()
  private readonly scheduler = createScheduler({ storage: cloudflareSchedulerStorage(this.ctx.storage), deliver: wake => Effect.suspend(() => typeof wake.target === "object" && wake.target !== null && "owner" in wake.target && wake.target.owner === "effect" ? this.recoverStore().pipe(Effect.asVoid) : this.watchdog.alarm) })
  private readonly watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(this.ctx.storage), policy: nativeRecoveryPolicy,
    recover: () => this.recoverStore(),
    // @effect-diagnostics-next-line effectSucceedWithVoid:off: A cold Durable Object has no live probe result.
    probe: () => this.store ? Effect.try({ try: () => this.store!.recoveryState(), catch: RuntimeError.from }) : Effect.succeed(undefined),
    invalidate: () => Effect.suspend(() => this.store ? this.store.close.pipe(Effect.tap(() => Effect.sync(() => { this.store = undefined }))) : Effect.void),
  })
  private readonly journal = objectJournal<typeof NativeEvent.Type>({ storage: this.ctx.storage, key: "native-input", target: nativeTarget, watchdog: this.watchdog, checkpointChunkBytes: 127 })
  private store: Awaited<ReturnType<InputLifecycleDO["createStore"]>> | undefined

  private observe(kind: NativeCall["kind"], input: string, ref: EffectRef) {
    return Effect.tryPromise({ try: async () => {
      const calls = await this.ctx.storage.get<readonly NativeCall[]>("calls") ?? []
      await this.ctx.storage.put("calls", [...calls, { kind, input, ref, instance: this.instance }])
    }, catch: RuntimeError.from })
  }

  private createStore(input: string, mode: "pending" | "deferred" | "complete", cleanup: "retry" | "success", attemptTimeoutMs?: number | null) {
    return Effect.runPromise(createActorStore({
      actor: defineActor("native-input", Effect.sync(() => {
        const request = NativeJob.request({ input, onSettled: completion.onSettled })
        return { schema: NativeEvent, atom: effectAtom(get => ({ view: get(completion.state), events: {}, acts: get(completion.state).status === "pending" ? { job: request } : {} })) }
      })), journal: this.journal, effectInput: { digestMinBytes: 0 }, checkpoint: { mode: "manual" }, cancellation: { retryIntervalMs: 250 }, actorContext: Context.pick(), ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
      services: () => Layer.mergeAll(Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }), Layer.succeed(Scheduler, this.scheduler), NativeJob.layer((accepted, { ref }) => Effect.gen({ self: this }, function* () {
        yield* this.observe("execution", accepted, ref)
        const handle = yield* Effect.tryPromise({ try: signal => this.external.submit(effectKey(ref), accepted, signal), catch: RuntimeError.from })
        if (mode === "pending") return yield* Effect.never
        if (mode === "deferred") return NativeJob.defer(handle)
        yield* Effect.tryPromise({ try: signal => waitFor(() => this.external.job(handle.id, signal), job => job?.status === "completed"), catch: RuntimeError.from })
        return accepted
      }).pipe(Effect.mapError(String)), { cancel: (accepted, { ref }) => Effect.gen({ self: this }, function* () {
        yield* this.observe("cleanup", accepted, ref)
        const allowedAfter = yield* Effect.promise(() => this.ctx.storage.get<string>("allow-cleanup"))
        if (cleanup === "retry" && (!allowedAfter || allowedAfter === this.instance)) return yield* Effect.fail(new RuntimeError("Retry native cleanup"))
        yield* Effect.tryPromise({ try: signal => this.external.cancel(effectKey(ref), signal), catch: RuntimeError.from })
      }) })),
    }))
  }

  private recoverStore() {
    return Effect.gen({ self: this }, function* () {
      if (!this.store) {
        if (yield* Effect.promise(() => this.ctx.storage.get<boolean>("hold-recovery"))) return yield* Effect.never
        const config = yield* Effect.tryPromise({ try: () => this.ctx.storage.get<NativeConfig>("config"), catch: RuntimeError.from })
        if (!config) return yield* Effect.fail(new RuntimeError("Native lifecycle configuration is missing"))
        this.store = yield* Effect.tryPromise({ try: () => this.createStore(config.input, config.mode, config.cleanup, config.attemptTimeoutMs), catch: RuntimeError.from })
      }
      yield* this.store.resume
      yield* this.store.recover
      return this.store.recoveryState()
    })
  }
  async alarm() { await Effect.runPromise(this.watchdog.restore.pipe(Effect.andThen(this.scheduler.alarm))) }
  async allowCleanup() { await this.ctx.storage.put("allow-cleanup", this.instance) }
  async holdRecovery(hold: boolean) { await this.ctx.storage.put("hold-recovery", hold) }
  async configure(config: NativeConfig) { await this.ctx.storage.put("config", config); if (config.mode === "complete") await this.external.configure({ holdExecution: false }) }
  async remoteControl(policy: Partial<EffectServicePolicy>) { await this.external.configure(policy) }
  async open(input: string, mode: "pending" | "deferred" | "complete", cleanup: "retry" | "success", attemptTimeoutMs?: number | null) {
    if (this.store) throw new Error("Native fixture must be evicted before reopening")
    await this.external.configure({ holdExecution: mode !== "complete", runDurationMs: 5, cancelDelayMs: 5 })
    await this.ctx.storage.put("config", { input, mode, cleanup, ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }) } satisfies NativeConfig)
    this.store = await this.createStore(input, mode, cleanup, attemptTimeoutMs)
    return this.instance
  }
  async state() {
    return { instance: this.instance, service: this.ctx.id.toString(), externalJobs: await this.external.jobs(), records: await Effect.runPromise(journalCall(() => this.journal.read())), inputs: await Effect.runPromise(journalCall(() => this.journal.readInputs())), calls: await this.ctx.storage.get<readonly NativeCall[]>("calls") ?? [], watchdog: [...(await this.ctx.storage.list<WatchdogEntry>({ prefix: "tardie:watchdog:" })).values()], alarmAt: await this.ctx.storage.getAlarm() }
  }
  async cancel(ref: EffectRef) { await Effect.runPromise(this.store!.cancel(ref, "stop")) }
  async resume() { await Effect.runPromise(this.store!.resume) }
  async wait() { await Effect.runPromise(this.store!.wait) }
  async checkpoint() { return Effect.runPromise(this.store!.checkpoint.pipe(Effect.match({ onSuccess: () => "captured", onFailure: error => error.message }))) }
  abort() { this.ctx.abort("Native input reset fixture") }
  async dispose() {
    try { await this.external.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }) }
    finally {
      try { if (this.store) await Effect.runPromise(this.store.close) }
      finally {
        try { await Effect.runPromise(this.journal.close); await this.ctx.storage.deleteAlarm() }
        finally { await this.external.dispose() }
      }
    }
  }
}
