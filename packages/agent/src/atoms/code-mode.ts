import { Effect, Option, Schema } from "effect"
import { effectAtom, eventValue, RuntimeError, type ActRequest, type ActService, type EventValue } from "@clavia/tardigrade-core"
import { failureMessage } from "../contracts/acts"
import { pendingTools } from "./durable/tools"
import { type LibrarySource } from "@clavia/tardigrade-libraries/types"
import { codeModeSpec, selectLibraries } from "../contracts/libraries"
import { ToolCatalog } from "../actor/context"
import { ToolReturned, type ToolCalled } from "../contracts/events"
import { CodeReturned, Event, EvaluateCode, ExecutePackage, PackageReturned } from "../contracts/code-mode"
import { CodeModeName, codeModeCoordinate } from "../contracts/code-mode-reference"
import { executions as state } from "./durable/code-mode"

const CodeInput = Schema.Struct({ code: Schema.String })

// codeMode observes model tool calls and proposes sandbox evaluation, package execution, and tool results.
export const DEFAULT_CODE_MODE_NAME = "agent.code-mode"
export interface CodeModeOptions { readonly name?: string; readonly signatureDepth?: number }
export function codeMode(libraries: readonly LibrarySource[], options?: CodeModeOptions): ReturnType<typeof createCodeMode>
export function codeMode(options?: CodeModeOptions): ReturnType<typeof createCodeMode>
export function codeMode(librariesOrOptions: readonly LibrarySource[] | CodeModeOptions = {}, options: CodeModeOptions = {}) {
  return Array.isArray(librariesOrOptions) ? createCodeMode(options, librariesOrOptions) : createCodeMode(librariesOrOptions as CodeModeOptions)
}

function createCodeMode(options: CodeModeOptions, sources?: readonly LibrarySource[]) {
  const name = Schema.decodeSync(CodeModeName)(options.name ?? DEFAULT_CODE_MODE_NAME)
  return Effect.gen(function* () {
    const catalog = yield* ToolCatalog
    const libraries = sources ? selectLibraries(sources, catalog.libraries ?? []) : undefined
    const spec = libraries ? codeModeSpec(libraries, options.signatureDepth) : catalog.specs.find(spec => spec.name === "execute")
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
      const acts: Record<string, ActRequest<Schema.Json, string, ActService<"code-mode.evaluate"> | ActService<"code-mode.package">>> = {}
      const view = { specs: [spec], system: spec.description, executions }
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
          const coordinate = codeModeCoordinate({ codeMode: name, callId: call.callId })
          const key = coordinate.tag
          let request = evaluations.get(key)
          if (!request) {
            request = EvaluateCode.request({
              tag: key, input: { codeMode: name, callId: call.callId, code: parsed.value.code, ...(libraries ? { libraries: libraries.map(library => library.name) } : {}) },
              onSettled: outcome => [{ type: "CodeReturned", codeMode: name, callId: call.callId, outcome: outcome.status === "rejected" ? { ...outcome, reason: failureMessage(outcome.reason) } : outcome } satisfies typeof CodeReturned.Type],
            })
            evaluations.set(key, request)
          }
          acts[coordinate.source] = request
        }
        const open = execution.calls.filter(call => call.outcome === null)
        if (open.length) {
          for (const packageCall of open) {
            const coordinate = codeModeCoordinate({ codeMode: name, callId: call.callId }, packageCall.ordinal)
            const key = coordinate.tag
            let request = packages.get(key)
            if (!request) {
              request = ExecutePackage.request({
                tag: key, input: { codeMode: name, callId: call.callId, ordinal: packageCall.ordinal, package: packageCall.package, method: packageCall.method, input: packageCall.input },
                onSettled: (outcome, ref) => [{ type: "PackageReturned", codeMode: name, callId: call.callId, ordinal: packageCall.ordinal, ref, outcome: outcome.status === "rejected" ? { ...outcome, reason: failureMessage(outcome.reason) } : outcome } satisfies typeof PackageReturned.Type],
              })
              packages.set(key, request)
            }
            acts[coordinate.source] = request
          }
        }

      }
      return { view, events, acts }
    })
  })
}
