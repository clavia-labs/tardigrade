import {expect, test} from "bun:test"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {Context, Effect, Layer, Schema} from "effect"
import {act, defineActor, durableAtom, effectAtom, event, EffectExecution, type ActorRuntime} from "@clavia/tardigrade-core"
import {bifrostResponsesClient} from "@clavia/tardigrade-platform/bifrost-responses"
import {HttpBody, HttpClient, HttpClientResponse} from "effect/unstable/http"
import {createBunHost, bunPromises} from "../../src/bun"

// Real native producer, journal, retry, resolver and cold reopen. A producer can
// submit several requests; replay must retain its fulfilled prefix as well as its
// ambiguous ordinal, otherwise one logical retry can allocate multiple jobs.
test("unacknowledged external submission reuses the entire producer generation after reopen", async () => {
 const directory = await mkdtemp(join(tmpdir(), "external-submit-retry-"))
 const Settled = event({type: "SubmitSettled", value: Schema.Array(Schema.Json)})
 const state = durableAtom({name: "submit.result", input: Settled, schema: Schema.NullOr(Schema.Array(Schema.Json)), initial: null, reduce: (_, entry) => entry.value})
 const Job = act({name: "submit.sequence", input: Schema.Null, success: Schema.Array(Schema.Json), failure: Schema.String})
 const actor = defineActor("external-submit", Effect.sync(() => ({schema: Settled, atom: effectAtom(get => {
  const result = get(state)
  return {view: result, events: {}, acts: result === null ? {job: Job.request({input: null, onSettled: outcome => outcome.status === "fulfilled" ? [Settled.make({value: outcome.value})] : []})} : {}}
 })})))
 const jobs = new Map<string, string>(), calls: {key: string; submission: number; attempt: number; deadlineAt: number}[] = []
 const deadlineAt = Date.now() + 60_000
 let rejected = false
 const options = {actor, actorContext: Context.pick(), storage: directory, attemptTimeoutMs: null,
  services: (_coordinate: unknown, runtime: ActorRuntime<typeof Settled.Type>) => Layer.mergeAll(
   Job.layer(() => Effect.gen(function* () {
    const execution = yield* EffectExecution
    const client = bifrostResponsesClient(HttpClient.make(request => Effect.gen(function* () {
      const key = request.headers["x-bf-async-idempotency-key"]!
      const parts = JSON.parse(key) as unknown[]
      const submission = parts.at(-1) as number, attempt = parts.at(-2) as number
      calls.push({key, submission, attempt, deadlineAt: Date.parse(request.headers["x-bf-async-deadline"]!)})
      let id = jobs.get(key)
      if (!id) {id = `job-${jobs.size}`; jobs.set(key, id)}
      if (submission === 1 && !rejected) {rejected = true; yield* Effect.sleep(100)}
      return HttpClientResponse.fromWeb(request, Response.json({id}, {status: 202}))
    })), {endpoint: "https://gateway.example/v1/async/responses", requestTimeoutMs: 10, deadlineAt: () => Effect.succeed(deadlineAt)})
    return yield* execution.retry(Effect.gen(function* () {
     const results: Schema.Json[] = []
     for (let ordinal = 0; ordinal < 3; ordinal++) {
      const response = yield* client.post("https://gateway.example/v1/responses", {body: HttpBody.uint8Array(new TextEncoder().encode(JSON.stringify({ordinal})), "application/json")})
      results.push(yield* response.json)
     }
     return results
    }), {decide: (error, attempt) => Effect.succeed(attempt < 2 ? {delayMs: 500, reason: {code: "async_submission_timeout", message: String(error)}} : undefined)})
   }).pipe(Effect.mapError(String))),
   bunPromises(runtime, {poll: handle => Effect.succeed({status: "fulfilled", value: handle.id}), policy: {pollIntervalMs: 1}, deliver: (settlement, request) => runtime.settle(request, settlement.result)}),
  ),
 }
 let host = await Effect.runPromise(createBunHost(options))
 try {
  const thread = await Effect.runPromise(host.allocateRootThread({instance: "fixture", name: "sequence"}))
  const until = async (ready: () => Promise<boolean>, label: string) => {
   const end = Date.now() + 8_000
   while (!(await ready())) {if (Date.now() > end) throw new Error(label); await Bun.sleep(5)}
  }
  await until(async () => Array.from(await Effect.runPromise(thread.records())).some(row => row.event.type === "RetryScheduled"), "native retry not retained")
  await Effect.runPromise(host.close)
  host = await Effect.runPromise(createBunHost(options))
  const reopened = await Effect.runPromise(host.getThread({instance: "fixture", thread: "sequence"}))
  expect(reopened).toBeDefined()
  await Effect.runPromise(reopened!.resume)
  await until(async () => Array.from(await Effect.runPromise(reopened!.records())).some(row => row.event.type === "SubmitSettled"), "reopened producer did not settle")
  const events = Array.from(await Effect.runPromise(reopened!.records()), row => row.event)
  expect(jobs.size).toBe(3)
  expect(calls.map(call => call.submission)).toEqual([0, 1, 1, 2])
  expect(calls[1]!.key).toBe(calls[2]!.key)
  expect(new Set(calls.map(call => call.deadlineAt))).toEqual(new Set([deadlineAt]))
  expect(events.filter(row => row.type === "ExternalRequested")).toHaveLength(3)
  expect(events.filter(row => row.type === "ExternalSubmitted")).toHaveLength(3)
  expect(events.filter(row => row.type === "ExternalSettled")).toHaveLength(3)
  const count = calls.length
  await Effect.runPromise(reopened!.resume)
  expect(calls.length).toBe(count)
 } finally {await Effect.runPromise(host.close); await rm(directory, {recursive: true, force: true})}
}, 15_000)
