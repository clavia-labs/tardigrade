import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"
import { sandboxReturned } from "@clavia/tardigrade-code/sandbox/service"
import type { SandboxBridgeCall } from "../src/sandbox"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"
import { workerLoaderSandboxServiceFor } from "../src/sandbox"
import {
  ISOLATED_CALLBACK_TRANSPORT,
  isolatedCallbackTransportBody,
  type IsolatedCallbackTransportOptions,
  type IsolatedCallbackTransportResult
} from "./sandbox.cases"

export interface Env {
  readonly BRIDGE: DurableObjectNamespace<SandboxBridge>
  readonly LOADER: WorkerLoader
}

export class SandboxBridge extends DurableObject<Env> {
  private readonly callbacks = new Map<string, (
    ordinal: number,
    packageName: string,
    method: string,
    args: unknown
  ) => Promise<SandboxCallOutcome>>()

  private callbackIngress = 0

  // modeledDistinctExecutionBudget bounds distinct callback reentries for sandbox.workers.ts.
  private modeledDistinctExecutionBudget: { readonly max: number; remaining: number } | undefined

  private readonly modeledExecutions = new Set<string>()

  async sandboxCallBatch(
    execution: string,
    calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    const modeledBudget = this.modeledDistinctExecutionBudget
    if (modeledBudget !== undefined && !this.modeledExecutions.has(execution)) {
      if (this.modeledExecutions.size >= modeledBudget.max || modeledBudget.remaining === 0) {
        throw new Error(`fixture modeled callback budget exhausted at ${this.modeledExecutions.size} distinct executions`)
      }
      this.modeledExecutions.add(execution)
      modeledBudget.remaining--
    }
    this.callbackIngress++
    const callback = this.callbacks.get(execution)
    if (callback === undefined) throw new Error(`sandbox execution ${JSON.stringify(execution)} is unavailable`)
    return Promise.all(calls.map((call) => callback(call.ordinal, call.packageName, call.method, call.args)))
  }

  async runIsolatedCallbackTransport(
    options: IsolatedCallbackTransportOptions = {}
  ): Promise<IsolatedCallbackTransportResult> {
    const configuredBudget = options.modeledDistinctExecutionBudget
    if (configuredBudget !== undefined && (
      configuredBudget.initialBudget < 0 ||
      configuredBudget.maxDistinctExecutions < configuredBudget.initialBudget
    )) {
      throw new Error("fixture modeled callback budget is invalid")
    }
    this.callbacks.clear()
    this.callbackIngress = 0
    this.modeledExecutions.clear()
    this.modeledDistinctExecutionBudget = configuredBudget === undefined
      ? undefined
      : { max: configuredBudget.maxDistinctExecutions, remaining: configuredBudget.initialBudget }
    let packageCalls = 0
    let resultMarkers = 0
    for (let index = 0; index < ISOLATED_CALLBACK_TRANSPORT.executions; index++) {
      const execution = `isolated-${index}`
      const localState = { calls: 0 }
      const sandbox = workerLoaderSandboxServiceFor(this.env.LOADER, (callback) => {
        this.callbacks.set(execution, callback)
        return {
          binding: this.env.BRIDGE.get(this.ctx.id),
          execution,
          close: () => this.callbacks.delete(execution)
        }
      })
      const result = await Effect.runPromise(sandbox.run(isolatedCallbackTransportBody, {
        tools: {
          mark: async (input) => {
            const step = (input as { readonly step: number }).step
            if (step !== localState.calls) throw new Error(`unexpected step ${step}`)
            localState.calls++
            return sandboxReturned(`${execution}:${step}`)
          }
        }
      }))
      if (!Array.isArray(result.result) || result.result.length !== ISOLATED_CALLBACK_TRANSPORT.callsPerExecution) {
        throw new Error(
          `sandbox execution ${index} returned ${JSON.stringify(result.error)} after ${this.callbackIngress} callback ingress calls`
        )
      }
      packageCalls += localState.calls
      resultMarkers += result.result.length
    }
    return {
      executions: ISOLATED_CALLBACK_TRANSPORT.executions,
      packageCalls,
      callbackIngress: this.callbackIngress,
      resultMarkers
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/isolated-callback-transport") return new Response("worker loader test")
    const name = url.searchParams.get("name") ?? crypto.randomUUID()
    try {
      const result = await env.BRIDGE.getByName(name).runIsolatedCallbackTransport()
      return Response.json(result)
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 })
    }
  }
} satisfies ExportedHandler<Env>
