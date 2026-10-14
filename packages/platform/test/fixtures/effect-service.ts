import { isDeepStrictEqual } from "node:util"
import { Effect, type Schema } from "effect"
import { RuntimeError, type ActorRuntime, type Promises } from "@clavia/tardigrade-core"
import { waitFor, DEFAULT_WAIT_POLICY } from "./wait"

export const DEFAULT_EFFECT_SERVICE_POLICY = { startDelayMs: 0, runDurationMs: 60_000, cancelDelayMs: 0, cancelFailures: 0, failExecution: false, responseTimeoutMs: DEFAULT_WAIT_POLICY.timeoutMs, pollIntervalMs: DEFAULT_WAIT_POLICY.pollIntervalMs, holdExecution: false, holdSubmissionResponse: false, holdCancellationResponse: false, streamChunkIntervalMs: 0, streamChunks: 3, holdStreamResponse: false, holdStreamAfter: 0 }
export type EffectServicePolicy = typeof DEFAULT_EFFECT_SERVICE_POLICY
export interface EffectServiceJob {
  readonly id: string
  readonly input: Schema.Json
  readonly policy: EffectServicePolicy
  submissions: number
  executions: number
  cancellationRequests: number
  cancellationAcknowledgements: number
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled"
  nextAt: number | null
  outputs: Schema.Json[]
  history: string[]
}
export interface EffectServiceState { policy: EffectServicePolicy; jobs: EffectServiceJob[] }
export const initialEffectServiceState = (): EffectServiceState => ({ policy: { ...DEFAULT_EFFECT_SERVICE_POLICY }, jobs: [] })
export const effectServiceAlarm = (state: EffectServiceState): number | null => state.jobs.reduce<number | null>((at, job) => job.nextAt === null ? at : at === null ? job.nextAt : Math.min(at, job.nextAt), null)

const advance = (state: EffectServiceState, now: number) => {
  for (const job of state.jobs) {
    if (job.nextAt === null || job.nextAt > now) continue
    if (job.status === "queued") {
      job.status = "running"
      job.executions++
      job.history.push("started")
      job.nextAt = state.policy.holdExecution ? null : job.nextAt + job.policy.runDurationMs
    }
    if (job.nextAt === null || job.nextAt > now) continue
    if (job.status === "running") {
      job.status = job.policy.failExecution ? "failed" : "completed"
      if (!job.policy.failExecution) job.outputs.push(job.input)
      job.history.push(job.status)
      job.nextAt = null
    } else if (job.status === "cancelling") {
      job.status = "cancelled"
      job.cancellationAcknowledgements++
      job.history.push("cancelled")
      job.nextAt = null
    }
  }
}

// effectService owns durable jobs and scheduled state changes independently of the actor under test (operationLifecycle).
export function effectService(storage: {
  readonly read: () => Promise<EffectServiceState>
  readonly transaction: <Value>(work: (state: EffectServiceState) => Value) => Promise<Value>
}) {
  const streams = new Set<{ cancelled: boolean; controller?: ReadableStreamDefaultController<Uint8Array> }>()
  const pulls = new Set<Promise<void>>()
  const closeStreams = async () => {
    for (const stream of streams) { stream.cancelled = true; stream.controller?.close() }
    await Promise.allSettled(pulls)
    streams.clear()
  }
  const alarm = () => storage.transaction(state => advance(state, Date.now()))
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === "/controls" && request.method === "GET") return Response.json((await storage.read()).policy)
    if (url.pathname === "/controls" && request.method === "POST") {
      const patch = await request.json() as Partial<EffectServicePolicy>
      for (const key of ["startDelayMs", "runDurationMs", "cancelDelayMs", "cancelFailures", "responseTimeoutMs", "pollIntervalMs", "streamChunkIntervalMs", "streamChunks", "holdStreamAfter"] as const) if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || patch[key]! < 0)) throw new Error(`Invalid effect-service ${key}`)
      await storage.transaction(state => {
        state.policy = { ...state.policy, ...patch }
        if (patch.holdExecution === false) for (const job of state.jobs) if (job.status === "running" && job.nextAt === null) job.nextAt = Date.now() + job.policy.runDurationMs
        advance(state, Date.now())
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === "/" && request.method === "DELETE") {
      await closeStreams()
      await storage.transaction(state => { state.jobs = []; state.policy = { ...DEFAULT_EFFECT_SERVICE_POLICY } })
      return Response.json({ ok: true })
    }
    if (url.pathname === "/jobs" && request.method === "GET") return Response.json((await storage.read()).jobs)
    const id = decodeURIComponent(url.pathname.slice("/jobs/".length).replace(/\/(cancel|stream)$/, ""))
    if (request.method === "GET" && url.pathname.endsWith("/stream")) {
      const job = (await storage.read()).jobs.find(job => job.id === id)
      if (!job) return new Response("Unknown job", { status: 404 })
      const stream: { cancelled: boolean; controller?: ReadableStreamDefaultController<Uint8Array> } = { cancelled: false }
      streams.add(stream)
      let sent = 0
      const observe = (event: string) => storage.transaction(state => { state.jobs.find(job => job.id === id)?.history.push(event) })
      await observe("stream_opened")
      return new Response(new ReadableStream<Uint8Array>({
        start: controller => { stream.controller = controller },
        pull: controller => {
          const pending = (async () => {
            const { policy } = await storage.read()
            await waitFor(storage.read, state => stream.cancelled || !state.policy.holdStreamResponse || sent < state.policy.holdStreamAfter, { timeoutMs: policy.responseTimeoutMs, pollIntervalMs: policy.pollIntervalMs })
            if (stream.cancelled) return
            if (policy.streamChunkIntervalMs) await new Promise(resolve => setTimeout(resolve, policy.streamChunkIntervalMs))
            if (stream.cancelled) return
            if (sent < policy.streamChunks) {
              await observe("stream_chunk")
              if (stream.cancelled) return
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ index: sent++, input: job.input })}\n`))
            }
            if (sent >= policy.streamChunks) { controller.close(); streams.delete(stream); await observe("stream_closed") }
          })()
          const finished = pending.catch(async error => { stream.cancelled = true; streams.delete(stream); await observe("stream_failed"); controller.error(error) }).finally(() => { pulls.delete(finished) })
          pulls.add(finished)
          return finished
        },
        cancel: () => { stream.cancelled = true; streams.delete(stream); return observe("stream_cancelled") },
      }), { headers: { "content-type": "application/x-ndjson" } })
    }
    if (request.method === "GET") return Response.json((await storage.read()).jobs.find(job => job.id === id) ?? null)
    if (request.method === "POST" && url.pathname.endsWith("/cancel")) {
      const result = await storage.transaction(state => {
        advance(state, Date.now())
        const job = state.jobs.find(job => job.id === id)
        if (!job) return "missing"
        job.cancellationRequests++
        if (job.cancellationRequests <= job.policy.cancelFailures) return "retry"
        if (job.status === "queued" || job.status === "running") {
          job.status = "cancelling"
          job.nextAt = Date.now() + job.policy.cancelDelayMs
          job.history.push("cancel_requested")
        } else if (job.status === "completed" || job.status === "failed") job.cancellationAcknowledgements = 1
        advance(state, Date.now())
        return "accepted"
      })
      if (result !== "accepted") return new Response(result, { status: result === "missing" ? 404 : 503 })
      const policy = (await storage.read()).policy
      await waitFor(storage.read, state => !state.jobs.some(job => job.id === id) || !state.policy.holdCancellationResponse && state.jobs.some(job => job.id === id && ["completed", "failed", "cancelled"].includes(job.status)), { timeoutMs: policy.responseTimeoutMs, pollIntervalMs: policy.pollIntervalMs })
      return Response.json({ ok: true })
    }
    if (request.method === "POST" && url.pathname.startsWith("/jobs/")) {
      const { input } = await request.json() as { input: Schema.Json }
      const accepted = await storage.transaction(state => {
        const existing = state.jobs.find(job => job.id === id)
        if (existing) {
          if (!isDeepStrictEqual(existing.input, input)) return false
          existing.submissions++
        } else state.jobs.push({ id, input, policy: { ...state.policy }, submissions: 1, executions: 0, cancellationRequests: 0, cancellationAcknowledgements: 0,
          status: "queued", nextAt: Date.now() + state.policy.startDelayMs, outputs: [], history: ["accepted"] })
        advance(state, Date.now())
        return true
      })
      if (!accepted) return new Response("Idempotency input changed", { status: 409 })
      const policy = (await storage.read()).policy
      await waitFor(storage.read, state => !state.policy.holdSubmissionResponse, { timeoutMs: policy.responseTimeoutMs, pollIntervalMs: policy.pollIntervalMs })
      return Response.json({ executor: "effect-service", id })
    }
    return new Response("Unknown effect-service request", { status: 404 })
  }
  return { fetch, alarm }
}

// effectServiceClient uses HTTP requests so actor interruption cannot roll back service commits.
export function effectServiceClient(fetch: (request: Request) => Promise<Response>) {
  const request = async <Value>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Value> => {
    const response = await fetch(new Request(`http://effect-service${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }), ...(signal ? { signal } : {}) }))
    if (!response.ok) throw new Error(`Effect service ${response.status}: ${await response.text()}`)
    return await response.json() as Value
  }
  return {
    policy: () => request<EffectServicePolicy>("/controls"),
    configure: (policy: Partial<EffectServicePolicy>) => request<void>("/controls", "POST", policy),
    submit: (id: string, input: Schema.Json, signal?: AbortSignal) => request<{ executor: string; id: string }>(`/jobs/${encodeURIComponent(id)}`, "POST", { input }, signal),
    cancel: (id: string, signal?: AbortSignal) => request<void>(`/jobs/${encodeURIComponent(id)}/cancel`, "POST", undefined, signal),
    stream: async (id: string, signal?: AbortSignal) => {
      const response = await fetch(new Request(`http://effect-service/jobs/${encodeURIComponent(id)}/stream`, signal ? { signal } : {}))
      if (!response.ok || !response.body) throw new Error(`Effect service stream ${response.status}`)
      return response.body
    },
    job: (id: string, signal?: AbortSignal) => request<EffectServiceJob | null>(`/jobs/${encodeURIComponent(id)}`, "GET", undefined, signal),
    jobs: () => request<EffectServiceJob[]>("/jobs"),
    dispose: () => request<void>("/", "DELETE"),
  }
}
export type EffectServiceClient = ReturnType<typeof effectServiceClient>

// effectServicePromises delivers observed service outcomes through the runtime's promise admission boundary (operationLifecycle).
export function effectServicePromises<Event extends object>(client: EffectServiceClient, runtime: ActorRuntime<Event>): typeof Promises.Service {
  return {
    watch: ({ ref, handle }) => runtime.fork(`effect-service:${handle.id}`, Effect.tryPromise({
      try: async signal => {
        const policy = await client.policy()
        return waitFor(() => client.job(handle.id, signal), job => job !== null && ["completed", "failed", "cancelled"].includes(job.status), { timeoutMs: policy.responseTimeoutMs, pollIntervalMs: policy.pollIntervalMs })
      }, catch: RuntimeError.from,
    }).pipe(Effect.flatMap(job => runtime.record({ type: "PromiseSettled", ref, result: job?.status === "completed" ? { status: "fulfilled", value: job.input } : { status: "rejected", reason: job?.status === "cancelled" ? { _tag: "Cancelled", reason: "service cancelled" } : "failed" } })))),
    cancel: () => Effect.void,
  }
}
