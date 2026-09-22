import { toolComponent, type ToolComponent, toolConcurrencyOf, toolDispatchMatches, type ToolConcurrency, type Answer, type PendingCall } from "../tool/machine"
import type { KeyValueStore } from "effect/unstable/persistence"
import { Chunk } from "effect"
import { type Transition } from "@clavia/tardigrade-core/runtime"
import { component as defineComponent, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/log"
import { executionKeyOf, codeDispatched, codeKeys } from "@clavia/tardigrade-code/execution/events"
import { codeExecution } from "@clavia/tardigrade-code/execution/code"
import type { CodePolicy } from "@clavia/tardigrade-code/execution/policy"
import { renderShape, renderSignature } from "@clavia/tardigrade-code/execution/contract"
import {
  type CodeComponent,
  type PackageView
} from "@clavia/tardigrade-code/package/definition"
import type { ToolSpec } from "../../model/request"

export const DEFAULT_CODE_SUMMARY_MAX_LENGTH = 240
// DEFAULT_CODE_TOOL_CONCURRENCY serializes execute admission (runtime/batches.test.ts).
export const DEFAULT_CODE_TOOL_CONCURRENCY: ToolConcurrency = 1

const executeTool = (summaryMaxLength: number): ToolSpec => ({
  name: "execute",
  description:
    "Run an async JavaScript body against the connected packages. Package objects are already in scope; await their methods and end with `return <value>`. The returned value comes back as this call's result, and console output comes back beside it as `logs` (capped; return the value you need, print to inspect).",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The JavaScript body to run." },
      summary: {
        type: "string",
        description: "One or two concise user-facing sentences that describe what this execution does and why.",
        minLength: 1,
        maxLength: summaryMaxLength,
        pattern: "\\S"
      }
    },
    required: ["code"],
    additionalProperties: false
  }
})

const CODE_SYSTEM_LEAD = "The execute tool runs an async JavaScript body with the connected packages already in scope as objects. Use ordinary JavaScript to coordinate calls. The calling pattern is `const value = await package.method(input); return value`. The packages in scope are:"
export const CODE_SYSTEM = `${CODE_SYSTEM_LEAD}\nnone`

// codeSystemFor names each package and renders every documented method's input and output schema.
// The declaration shown to the model is the same MethodDoc the dispatch funnel validates, so code
// generation and execution share one calling convention (packages/code/src/execution/contract.ts).
export const codeSystemFor = (packages: ReadonlyArray<Pick<PackageView, "name" | "description" | "docs">>): string =>
  `${CODE_SYSTEM_LEAD}\n${packages.length === 0 ? "none" : packages.map((pkg) => {
    const methods = Object.entries(pkg.docs ?? {}).map(
      ([name, doc]) =>
        `  ${pkg.name}.${renderSignature(name, doc.input)} -> ${renderShape(doc.output)}: ${doc.description}`
    )
    return [`${pkg.name}: ${pkg.description}`, ...methods].join("\n")
  }).join("\n")}`

const settleFor = (
  log: ReadonlyArray<Event>,
  callId: string
): { result?: unknown; error?: string; logs?: ReadonlyArray<string> } | undefined => {
  const settle = log.find((e) => e.type === "CodeSettled" && executionKeyOf(e) === callId) as
    | { result?: unknown; error?: unknown; logs?: ReadonlyArray<string>; tmp?: unknown; size?: unknown; preview?: unknown; note?: unknown }
    | undefined
  if (settle === undefined) return undefined
  const logs = settle.logs !== undefined && settle.logs.length > 0 ? { logs: settle.logs } : {}
  if (settle.error !== undefined) return { error: String(settle.error), ...logs }
  if (settle.tmp !== undefined) {
    return { result: { tmp: settle.tmp, size: settle.size, preview: settle.preview, note: settle.note }, ...logs }
  }
  return { result: settle.result, ...logs }
}

const serveCode = (log: ReadonlyArray<Event>, call: PendingCall, answer: Answer): ReadonlyArray<Transition<never>> => {
  const stamp = {
    ...(call.turn === undefined ? {} : { turn: call.turn }),
    ...(call.epoch === undefined || call.epoch === 0 ? {} : { epoch: call.epoch })
  }
  const dispatched = log.find((event) => event.type === "CodeDispatched" && (call.context.matches("dispatch", event) || toolDispatchMatches(event, call)))
  if (dispatched !== undefined) {
    const outcome = settleFor(log, executionKeyOf(dispatched))
    return outcome === undefined ? [] : [answer(outcome)]
  }
  const code = String((call.arguments as { code?: unknown } | undefined)?.code ?? "")
  const dispatch = call.context.intent("dispatch", (at) =>
    codeDispatched({ execId: dispatch.key, code, ...stamp, at }), (call.turn === undefined ? {} : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }))
  return [dispatch]
}

export interface CodeModeOptions {
  readonly toolConcurrency?: ToolConcurrency
  readonly policy?: Partial<CodePolicy>
  readonly system?: string | ((log: ReadonlyArray<Event>) => string)
  readonly summaryMaxLength?: number
}

const summaryMaxLengthOf = (value: number | undefined): number => {
  const length = value ?? DEFAULT_CODE_SUMMARY_MAX_LENGTH
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("code summaryMaxLength must be a positive safe integer")
  }
  return length
}

const rootKeys = (children: KeyFragment | undefined): KeyFragment => {
  const fragments = [codeKeys, ...(children === undefined ? [] : [children])]
  return {
    prefixes: fragments.flatMap((fragment) => fragment.prefixes),
    keyOf: composeKeys(...fragments)
  }
}

// codeMode composes code components and exposes their package scope through one execute tool.
export const codeMode = <
  const Cs extends ReadonlyArray<CodeComponent<never> | CodeComponent<unknown>> = readonly []
>(
  components: Cs = [] as unknown as Cs,
  options: CodeModeOptions = {}
): ToolComponent<KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = KeyValueStore.KeyValueStore | ComponentR
  const summaryMaxLength = summaryMaxLengthOf(options.summaryMaxLength)
  const toolConcurrency = toolConcurrencyOf(options.toolConcurrency ?? DEFAULT_CODE_TOOL_CONCURRENCY)
  const combined = codeExecution(components, options.policy)
  const staticSystem = typeof options.system === "string" ? options.system : undefined
  const dynamicSystem = typeof options.system === "function" ? options.system : undefined
  const component = defineComponent({
    children: combined,
    name: "code",
    initial: () => Chunk.empty<Event>(),
    step: (state, event) => dynamicSystem === undefined ? state : Chunk.append(state, event),

    output: (state, child) => {
      const children = child.output()
      const packages = children.view.packages
      return {
        view: {
          system: [dynamicSystem?.(Chunk.toReadonlyArray(state)) ?? staticSystem ?? codeSystemFor(packages)],
          tools: [{ spec: executeTool(summaryMaxLength), concurrency: toolConcurrency }],
          context: [],
          output: []
        },
        transitions: [
          ...(children.transitions as ReadonlyArray<Transition<never, R>>)
        ],
        interactions: {
          tools: () => [{
            spec: executeTool(summaryMaxLength),
            concurrency: toolConcurrency,
            serve: (call: PendingCall, current: ReadonlyArray<Event>, answer: Answer) => serveCode(current, call, answer)
          }],
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  return toolComponent({ ...component, keys: rootKeys(combined.keys) })
}
