import { Effect, Option, Schema } from "effect"
import { effectAtom, eventValue, RuntimeError, cancel, Cancelled, type CancelRequest, type ActRequest, type ActService, type EventValue } from "@clavia/tardigrade-experimental-core"
import { pendingTools } from "./tools"
import { ToolCatalog } from "../context"
import { ToolReturned, type ToolCalled } from "../event"
import { CodeReturned, Event, EvaluateCode, ExecutePackage, PackageReturned } from "../code-mode/contracts"
import { executions as state } from "../code-mode/projections"

const CodeInput = Schema.Struct({ code: Schema.String })

// codeMode observes model tool calls and proposes sandbox evaluation, package execution, and tool results.
export function codeMode(options: { readonly name: string }) {
  const name = options.name
  if (!name || name.includes("/")) throw new RuntimeError("Code mode name must be nonempty and contain no slash")
  return Effect.gen(function* () {
    const catalog = yield* ToolCatalog
    const spec = catalog.specs.find(spec => spec.name === "execute")
    if (!spec) return yield* Effect.fail(new RuntimeError("Code mode requires an execute tool in ToolCatalog"))
    const evaluations = new Map<string, ReturnType<typeof EvaluateCode.request>>()
    const packages = new Map<string, ReturnType<typeof ExecutePackage.request>>()
    let current: string | undefined
    return effectAtom(get => {
      const executions = get(state)
      const queue = get(pendingTools)
      const call = queue.pending
      if (current !== call?.callId) {
        evaluations.clear()
        packages.clear()
        current = call?.callId
      }
      const events: Record<string, EventValue<typeof Event.Type>> = {}
      const acts: Record<string, ActRequest<Schema.Json, string, ActService<"code-mode.evaluate"> | ActService<"code-mode.package">> | CancelRequest> = {}
      const view = { specs: catalog.specs, system: spec.description, executions }
      if (!call) return { view, events, acts }
      const parsed = Schema.decodeUnknownOption(CodeInput, { onExcessProperty: "error" })(call.input)
      const error = call.name !== "execute" ? `Unknown tool: ${call.name}` : Option.isNone(parsed) ? "execute requires { code: string }" : undefined
      if (!queue.running) {
        events.called = eventValue({ type: "ToolCalled", callId: call.callId, counted: error === undefined } satisfies ToolCalled)
        return { view, events, acts }
      }
      const execution = executions.find(entry => entry.call.callId === call.callId)
      if (!execution) throw new RuntimeError("No code mode state for pending tool call")
      if (error || execution.outcome) {
        const outcome = execution.outcome
        const value = outcome?.status === "fulfilled" ? outcome.value : null
        const bodyError = Schema.is(Schema.Struct({ error: Schema.String }))(value) ? value.error : undefined
        events.returned = eventValue({ type: "ToolReturned", callId: call.callId, output: JSON.stringify(value),
          error: error ?? (outcome?.status === "rejected" ? outcome.reason : bodyError) ?? null,
        } satisfies ToolReturned)
      } else if (Option.isSome(parsed)) {
        {
          const key = call.callId
          let request = evaluations.get(key)
          if (!request) {
            request = EvaluateCode.request({
              tag: key, input: { codeMode: name, callId: call.callId, code: parsed.value.code },
              onSettled: outcome => [{ type: "CodeReturned", codeMode: name, callId: call.callId, outcome } satisfies typeof CodeReturned.Type],
            })
            evaluations.set(key, request)
          }
          acts[name] = request
          const result = get(request.result)
          if (result.status === "rejected" && Schema.is(Cancelled)(result.reason)) {
            for (const child of execution.calls) if (child.ref && child.outcome === null) {
              acts[`${name}.cancel.${child.ordinal}`] = cancel(child.ref, result.reason.reason)
            }
            return { view, events, acts }
          }
        }
        const open = execution.calls.filter(call => call.outcome === null)
        if (open.length) {
          for (const packageCall of open) {
            const key = JSON.stringify([call.callId, packageCall.ordinal])
            let request = packages.get(key)
            if (!request) {
              request = ExecutePackage.request({
                tag: key, input: { codeMode: name, callId: call.callId, ordinal: packageCall.ordinal, package: packageCall.package, method: packageCall.method, input: packageCall.input },
                onSettled: (outcome, ref) => [{ type: "PackageReturned", codeMode: name, callId: call.callId, ordinal: packageCall.ordinal, ref, outcome } satisfies typeof PackageReturned.Type],
              })
              packages.set(key, request)
            }
            acts[`${name}.package.${packageCall.ordinal}`] = request
          }
        }

      }
      return { view, events, acts }
    })
  })
}
