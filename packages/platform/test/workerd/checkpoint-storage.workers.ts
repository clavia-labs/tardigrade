import { journalCommit } from "@clavia/tardigrade-core"
import { effectServiceClient, type EffectServiceClient } from "../fixtures/effect-service"
import type { EffectServiceDO } from "../fixtures/workerd/effect-service.worker"
import { createWatchdog, effectKey, type CancellationOutcome, type Journal } from "@clavia/tardigrade-core"
import { objectJournal } from "../../src/cloudflare/objects"
import { cloudflareSchedulerStorage } from "../../src/cloudflare/scheduler"
import { cloudflareWatchdogStorage } from "../../src/cloudflare/watchdog"
import { Effect } from "effect"
import * as fc from "fast-check"
import { operationLifecycle, operationLifecycleCases, type LifecycleEvent, defaultAttemptDeadline, attemptDeadlineCases, attemptDeadlineLifecycle, streamDeadlineCases, streamDeadlineLifecycle, operationRaceCases, operationRace } from "../properties/runtime/operation-lifecycle"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { expect, test } from "vitest"
import { env } from "cloudflare:workers"
import { runInDurableObject, evictDurableObject } from "cloudflare:test"
import { cloudflareJournal, CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES } from "../../src/cloudflare"
import { pendingInputRecovery, cancellationInputRecovery, stoppedInputRecovery, cancellationStall, cancellationRetryRecovery } from "../properties/runtime/pending-input-recovery"
import { DEFAULT_WAIT_POLICY, testStage, waitFor } from "../fixtures/wait"
import { checkpointStorage } from "../properties/checkpoint-storage"
import { lazyAtomRecovery } from "../properties/runtime/atom-checkpoint"
import type { TestPromiseResolver, InputLifecycleDO } from "../fixtures/workerd/fixture.worker"


test("checkpointStorage", async () => {
  const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName("checkpoint-storage"), async (_instance, state) => {
    await checkpointStorage({ maxChunkBytes: CLOUDFLARE_MAX_CHECKPOINT_CHUNK_BYTES, open: checkpointChunkBytes => cloudflareJournal(state.storage, "events", { checkpointChunkBytes, eventInlineBytes: 1 }), execute: async query => state.storage.sql.exec(query).toArray() })
  })
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("accepted input recovery", async () => {
  const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  for (const legacy of [false, true]) {
    await runInDurableObject(namespace.getByName(`accepted-input-recovery-${legacy}`), async (_instance, state) => {
      await pendingInputRecovery({ open: actor => cloudflareJournal(state.storage, actor, { checkpointChunkBytes: 127 }) }, legacy)
    })
  }
  await runInDurableObject(namespace.getByName("accepted-input-recovery"), async (_instance, state) => {
    const fixture: Parameters<typeof cancellationInputRecovery>[0] = { open: (actor: string) => cloudflareJournal(state.storage, actor, { checkpointChunkBytes: 127 }), execute: async (_name: string, query: string) => state.storage.sql.exec(query).toArray() }
    await stoppedInputRecovery(fixture)
    await stoppedInputRecovery(fixture, true)
  })
  for (const version of [2, 3] as const) {
    await runInDurableObject(namespace.getByName(`legacy-cleanup-${version}`), async (_instance, state) => {
      const fixture: Parameters<typeof cancellationInputRecovery>[0] = { open: (actor: string) => cloudflareJournal(state.storage, actor, { checkpointChunkBytes: 127 }), execute: async (_name: string, query: string) => state.storage.sql.exec(query).toArray() }
      await cancellationInputRecovery(fixture, version)
    })
  }
})

test("lazy atom checkpoint recovery", async () => {
  const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName("lazy-atom-checkpoint"), async (_instance, state) => {
    await lazyAtomRecovery({ open: () => cloudflareJournal(state.storage, "lazy-checkpoint") })
  })
})

for (const mode of ["producer", "cleanup", "failure", "defect", "rejected"] as const) {
  test(`unresolved cancellation: ${mode}`, async () => {
    const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
    await runInDurableObject(namespace.getByName(`cancellation-stall-${mode}`), async (_instance, state) => {
      await cancellationStall({ open: actor => cloudflareJournal(state.storage, actor) }, mode)
    })
  })
}

test("cancellation retry recovery", async () => {
  const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await runInDurableObject(namespace.getByName("cancellation-retry-recovery"), async (_instance, state) => {
    await cancellationRetryRecovery({ open: actor => cloudflareJournal(state.storage, actor) })
  })
})

for (const reset of ["evict", "abort"] as const) {
  for (const cleanup of [false, true]) {
    test(`native ${reset} recovers ${cleanup ? "cancellation" : "execution"} input`, async () => {
      const namespace = (env as unknown as { INPUT_LIFECYCLE: DurableObjectNamespace<InputLifecycleDO> }).INPUT_LIFECYCLE
      const name = `${reset}-${cleanup}`
      let stub = namespace.getByName(name)
      const restart = async () => {
        if (reset === "evict") await evictDurableObject(stub)
        else {
          try { await stub.abort() } catch (error) { expect(String(error)).toContain("Native input reset fixture") }
        }
        stub = namespace.getByName(name)
      }
      const original = "native-accepted".repeat(1_024)
      // attemptTimeoutMs disables active JavaScript timers for graceful eviction; abort exercises the default deadline.
      const attemptTimeoutMs = reset === "evict" ? null : undefined
      const instance = await stub.open(original, cleanup ? "deferred" : "pending", "retry", attemptTimeoutMs)
      try {
        const state = await waitFor(() => stub.state(), value => value.externalJobs[0]?.status === "running" && (cleanup ? value.records.some(record => record.event.type === "EffectSettled") : value.calls.length === 1))
        const ref = state.inputs[0]!.ref
        if (cleanup) {
          await stub.cancel(ref)
          await waitFor(() => stub.state(), value => value.records.some(record => record.event.type === "RetryScheduled" && record.event.phase === "cancellation"))
          expect(await stub.checkpoint()).toContain("Cannot checkpoint")
        }
        await stub.configure({ input: "replacement proposal", mode: cleanup ? "deferred" : "complete", cleanup: cleanup ? "retry" : "success" })
        if (cleanup) await stub.allowCleanup()
        await restart()
        expect((await stub.state()).instance).not.toBe(instance)
        await waitFor(() => stub.state(), value => value.inputs.length === 0)
        await stub.wait()
        const recovered = await stub.state()
        expect(recovered.inputs).toHaveLength(0)
        expect(recovered.calls.every(call => call.input === original && JSON.stringify(call.ref) === JSON.stringify(ref))).toBe(true)
        expect(recovered.calls.filter(call => call.kind === "execution")).toHaveLength(cleanup ? 1 : 2)
        expect(recovered.calls.at(-1)!.instance).toBe(recovered.instance)
        expect(recovered.records.filter(record => record.event.type === "EffectRequested")).toHaveLength(1)
        expect(recovered.externalJobs).toHaveLength(1)
        expect(recovered.externalJobs[0]!.input).toBe(original)
        expect(recovered.externalJobs[0]!.executions).toBe(1)
        expect(recovered.externalJobs[0]!.submissions).toBe(cleanup ? 1 : 2)
        expect(recovered.externalJobs[0]!.status).toBe(cleanup ? "cancelled" : "completed")
        expect(recovered.externalJobs[0]!.outputs).toEqual(cleanup ? [] : [original])
        if (cleanup) {
          expect(recovered.records.filter(record => record.event.type === "CancellationSettled")).toHaveLength(1)
          await restart()
          const acknowledged = await stub.state()
          expect(acknowledged.calls).toEqual(recovered.calls)
          expect(acknowledged.records).toEqual(recovered.records)
        }
      } finally { await stub.dispose() }
    })
  }
}

async function withEffectService(work: (journal: Journal<LifecycleEvent>, service: EffectServiceClient, execute: (query: string) => Promise<unknown>) => Promise<unknown>) {
  const actors = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  const services = (env as unknown as { EFFECT_SERVICE: DurableObjectNamespace<EffectServiceDO> }).EFFECT_SERVICE
  const name = crypto.randomUUID()
  await runInDurableObject(actors.getByName(name), async (_instance, state) => {
    const stub = services.getByName(name)
    const external = effectServiceClient(request => stub.fetch(request))
    const journal = cloudflareJournal<LifecycleEvent>(state.storage, "operation", { checkpointChunkBytes: 127 })
    try { await work(journal, external, async query => state.storage.sql.exec(query).toArray()) }
    finally {
      try { await external.configure({ holdSubmissionResponse: false, holdCancellationResponse: false }) }
      finally { try { await external.dispose() } finally { await Effect.runPromise(journal.close) } }
    }
  })
}

test("operation lifecycle crosses recovery boundaries", () => fc.assert(fc.asyncProperty(operationLifecycleCases, scenario =>
  withEffectService((journal, service) => operationLifecycle(journal, scenario, service))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

for (const result of ["success", "failure", "died"] as const) {
  test(`terminal cleanup ${result} cancels its retry wake`, async () => {
    const namespace = (env as unknown as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
    await runInDurableObject(namespace.getByName(`cleanup-wake-${result}`), async (_instance, state) => {
      const target = { actor: "cleanup-wake", instance: "main", thread: "one" }
      const watchdog = createWatchdog({ storage: cloudflareWatchdogStorage(state.storage), recover: () => Effect.succeed({ status: "settled", progressCursor: 0 }), invalidate: () => Effect.void })
      const journal = objectJournal({ storage: state.storage, key: "events", target, watchdog })
      const scheduler = cloudflareSchedulerStorage(state.storage)
      const ref = { seq: 0, atom: "job", act: "cleanup-wake" }
      try {
        await Effect.runPromise(journalCommit(journal, () => journal.append(0, [
          { event: { type: "EffectRequested", ref, request: { act: ref.act, input: { _tag: "InlineInput", value: null } } } },
          { event: { type: "EffectCancelled", ref, reason: "stop" } },
          { event: { type: "RetryScheduled", ref, phase: "cancellation", attempt: 1, dueAt: Date.now() + 60_000, reason: "retry" } },
        ])))
        expect((await Effect.runPromise(scheduler.transaction(tx => tx.list))).has(`effect:${effectKey(ref)}`)).toBe(true)
        const event: CancellationOutcome = result === "died" ? { type: "CancellationDied", ref, diagnostic: "cleanup defect" }
          : { type: "CancellationSettled", ref, outcome: result === "success" ? { status: "fulfilled" } : { status: "rejected", reason: "cleanup failed" } }
        await Effect.runPromise(journalCommit(journal, () => journal.append(3, [{ event }])))
        const wakes = await Effect.runPromise(scheduler.transaction(tx => tx.list))
        expect(wakes.has(`effect:${effectKey(ref)}`)).toBe(false)
        expect(wakes.has("watchdog")).toBe(true)
      } finally { await Effect.runPromise(journal.close) }
    })
  })
}

test("external cancellation survives actor abort and lost acknowledgement", async () => {
  const namespace = (env as unknown as { INPUT_LIFECYCLE: DurableObjectNamespace<InputLifecycleDO> }).INPUT_LIFECYCLE
  let stub = namespace.getByName("external-acknowledgement")
  let observed: Awaited<ReturnType<InputLifecycleDO["state"]>> | undefined
  const observe = async () => { observed = await stub.state(); return observed }
  try {
    const instance = await testStage("opening the actor", () => stub.open("independent-work", "deferred", "success"))
    const running = await testStage("waiting for external execution", () => waitFor(observe, state => state.externalJobs[0]?.status === "running"))
    const parked = await testStage("waiting for deferred execution to park", () => waitFor(observe, state => state.watchdog.some(entry => entry.nextWakeAt !== null && entry.nextWakeAt - Date.now() > DEFAULT_WAIT_POLICY.timeoutMs)))
    await testStage("holding the cancellation response", () => stub.remoteControl({ holdCancellationResponse: true, responseTimeoutMs: RUNTIME_PROPERTY_TEST_TIMEOUT_MS }))
    await testStage("accepting cancellation", () => stub.cancel(running.inputs[0]!.ref))
    const stopped = await testStage("waiting for the external job to stop", () => waitFor(observe, state => state.externalJobs[0]?.status === "cancelled"))
    expect(stopped.inputs).toHaveLength(1)
    expect(stopped.records.some(record => record.event.type === "CancellationSettled")).toBe(false)
    expect(stopped.watchdog[0]!.generation).toBe(parked.watchdog[0]!.generation + 1)
    await testStage("holding cold recovery", () => stub.holdRecovery(true))
    // The service has stopped the job; its response remains withheld across both DO resets.
    const services = (env as unknown as { EFFECT_SERVICE: DurableObjectNamespace<EffectServiceDO> }).EFFECT_SERVICE
    await testStage("aborting the actor", async () => {
      try { await stub.abort() } catch (error) { expect(String(error)).toContain("Native input reset fixture") }
    })
    await testStage("aborting the external service", async () => {
      try { await services.getByName(stopped.service).abort() } catch (error) { expect(String(error)).toContain("External effect service reset fixture") }
    })
    stub = namespace.getByName("external-acknowledgement")
    await testStage("observing the new actor instance", () => waitFor(observe, state => state.instance !== instance))
    const charged = await testStage("waiting for durable recovery admission", () => waitFor(observe, state => state.watchdog.some(entry => entry.attempts > (stopped.watchdog[0]?.attempts ?? 0))))
    expect(charged.inputs).toHaveLength(1)
    expect(charged.alarmAt).not.toBeNull()
    await testStage("releasing cold recovery", () => stub.holdRecovery(false))
    await testStage("aborting the admitted recovery", async () => {
      try { await stub.abort() } catch (error) { expect(String(error)).toContain("Native input reset fixture") }
    })
    stub = namespace.getByName("external-acknowledgement")
    const retried = await testStage("waiting for recovered cleanup", () => waitFor(observe, state => (state.externalJobs[0]?.cancellationRequests ?? 0) >= 2))
    expect(retried.instance).not.toBe(instance)
    expect(retried.inputs).toHaveLength(1)
    expect(retried.externalJobs[0]!.executions).toBe(1)
    expect(retried.externalJobs[0]!.cancellationAcknowledgements).toBe(1)
    await testStage("releasing the cancellation response", () => stub.remoteControl({ holdCancellationResponse: false }))
    const completed = await testStage("waiting for durable acknowledgement and input release", () => waitFor(observe, state => state.inputs.length === 0))
    expect(completed.externalJobs[0]!.status).toBe("cancelled")
    expect(completed.externalJobs[0]!.outputs).toEqual([])
    expect(completed.externalJobs[0]!.history.filter(event => event === "cancelled")).toHaveLength(1)
    expect(completed.records.filter(record => record.event.type === "CancellationSettled")).toHaveLength(1)
  } catch (cause) {
    throw new Error(`Cancellation recovery state: ${JSON.stringify(observed)}`, { cause })
  } finally { await testStage("disposing the actor fixture", () => stub.dispose()) }
}, RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("lost submission response reuses the external job after actor abort", async () => {
  const namespace = (env as unknown as { INPUT_LIFECYCLE: DurableObjectNamespace<InputLifecycleDO> }).INPUT_LIFECYCLE
  let stub = namespace.getByName("external-submission-response")
  await stub.remoteControl({ holdSubmissionResponse: true })
  const instance = await stub.open("accepted-once", "pending", "success")
  try {
    const accepted = await waitFor(() => stub.state(), state => state.externalJobs[0]?.status === "running")
    expect(accepted.externalJobs[0]!.submissions).toBe(1)
    expect(accepted.records.some(record => record.event.type === "EffectSettled")).toBe(false)
    await stub.configure({ input: "replacement input", mode: "complete", cleanup: "success" })
    try { await stub.abort() } catch (error) { expect(String(error)).toContain("Native input reset fixture") }
    stub = namespace.getByName("external-submission-response")
    const retried = await waitFor(() => stub.state(), state => (state.externalJobs[0]?.submissions ?? 0) >= 2)
    expect(retried.instance).not.toBe(instance)
    expect(retried.externalJobs).toHaveLength(1)
    expect(retried.externalJobs[0]!.executions).toBe(1)
    expect(retried.externalJobs[0]!.input).toBe("accepted-once")
    expect(retried.inputs).toHaveLength(1)
    await stub.remoteControl({ holdSubmissionResponse: false })
    const completed = await waitFor(() => stub.state(), state => state.inputs.length === 0)
    expect(completed.externalJobs[0]!.outputs).toEqual(["accepted-once"])
    expect(completed.externalJobs[0]!.history.filter(event => event === "accepted")).toHaveLength(1)
    expect(completed.records.filter(record => record.event.type === "EffectRequested")).toHaveLength(1)
  } finally { await stub.dispose() }
})

for (const phase of ["execution", "cleanup"] as const) {
  test(`default ${phase} deadline reaches the retry decision`, () =>
    withEffectService((journal, service) => defaultAttemptDeadline(journal, service, phase)))
}

test("attempt deadlines preserve the operation lifecycle", () => fc.assert(fc.asyncProperty(attemptDeadlineCases, scenario =>
  withEffectService((journal, service) => attemptDeadlineLifecycle(journal, service, scenario))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("stream deadlines preserve the operation lifecycle", () => fc.assert(fc.asyncProperty(streamDeadlineCases, scenario =>
  withEffectService((journal, service) => streamDeadlineLifecycle(journal, service, scenario))), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

for (const scenario of operationRaceCases) {
  test(`operation race ${scenario.order} (fault: ${scenario.fault})`, () =>
    withEffectService((journal, service, execute) => operationRace(journal, service, execute, scenario)))
}
