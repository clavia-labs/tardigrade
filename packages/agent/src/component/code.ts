import type { KeyValueStore } from "effect/unstable/persistence"
import { Chunk } from "effect"
import { intent, type Transition } from "@clavia/tardigrade-core/reconciliation"
import {
  composeComponents,
  inheritComponentContract,
  incrementalComponent,
  type ComponentRequirements,
  type InvocationCancellation
} from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/log"
import { codeDispatched, codeKeys, codeSettled } from "@clavia/tardigrade-code/execution/events"
import { eventEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { codeReactorFor, type CodePolicy, type CodeProjectionState } from "@clavia/tardigrade-code/execution/reactor"
import { renderShape, renderSignature } from "@clavia/tardigrade-code/execution/contract"
import {
  CODE_VIEW_ALGEBRA,
  type CodeComponent,
  type Package
} from "@clavia/tardigrade-code/package/definition"
import type { AgentComponent, AgentView } from "../runtime/composition"
import type { Answer, PendingCall } from "../runtime/tools"
import type { ToolSpec } from "../inference/request"

export const DEFAULT_CODE_SUMMARY_MAX_LENGTH = 240

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
export const codeSystemFor = (packages: ReadonlyArray<Package<unknown>>): string =>
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
  const settle = log.find((e) => e.type === "CodeSettled" && String((e as { execId?: unknown }).execId) === callId) as
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
  if (log.some((e) => e.type === "CodeDispatched" && String((e as { execId?: unknown }).execId) === call.callId)) {
    const outcome = settleFor(log, call.callId)
    return outcome === undefined ? [] : [answer(outcome)]
  }
  const code = String((call.arguments as { code?: unknown } | undefined)?.code ?? "")
  return [
    intent({
      key: `cd:${call.callId}`,
      ...(call.turn === undefined
        ? {}
        : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }),
      input: { execId: call.callId, code },
      events: (input, at) => [codeDispatched({ execId: input.execId, code: input.code, ...stamp, at })]
    })
  ]
}

export interface CodeModeOptions {
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

const codeCancellationTransition = <R>(
  execId: string,
  cancellation: InvocationCancellation
): ReadonlyArray<Transition<never, R>> => [intent({
  key: `cs:${execId}`,
  input: { execId, cancellation },
  events: (input, at) => [codeSettled({
    execId: input.execId,
    error: input.cancellation.reason === undefined
      ? "cancelled"
      : `cancelled: ${input.cancellation.reason}`,
    turn: input.cancellation.invocation.id,
    ...(input.cancellation.invocation.epoch === 0 ? {} : { epoch: input.cancellation.invocation.epoch }),
    at
  })]
})] as ReadonlyArray<Transition<never, R>>

// codeMode composes code components and exposes their package scope through one execute tool.
export const codeMode = <
  const Cs extends ReadonlyArray<CodeComponent<never> | CodeComponent<unknown>> = readonly []
>(
  components: Cs = [] as unknown as Cs,
  options: CodeModeOptions = {}
): AgentComponent<KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = KeyValueStore.KeyValueStore | ComponentR
  const summaryMaxLength = summaryMaxLengthOf(options.summaryMaxLength)
  const combined = composeComponents("code.children", CODE_VIEW_ALGEBRA, components) as CodeComponent<ComponentR>
  const childMachine = combined.machine
  const packagesOf = (state: unknown): ReadonlyArray<Package<ComponentR>> =>
    childMachine.output(state).view.packages as unknown as ReadonlyArray<Package<ComponentR>>

  codeReactorFor(options.policy ?? {}, packagesOf(childMachine.initial()))
  const common = {
    name: "code",
    keys: rootKeys(combined.keys)
  }
  const staticSystem = typeof options.system === "string" ? options.system : undefined
  const dynamicSystem = typeof options.system === "function" ? options.system : undefined
  const component = incrementalComponent({
        ...common,
        initial: () => {
          const children = childMachine.initial()
          const execution = codeReactorFor(options.policy ?? {}, packagesOf(children))
          return { children, execution: execution.initial(), history: Chunk.empty<Event>() }
        },
        step: (state, event) => {
          const execution = codeReactorFor(options.policy ?? {}, [])
          return {
            children: childMachine.step(state.children, event),
            execution: execution.step(state.execution, event),
            history: dynamicSystem === undefined ? state.history : Chunk.append(state.history, event)
          }
        },
        cancelState: (state, cancellation) => {
          const child = childMachine.cancel?.(state.children, cancellation) ?? []
          if (child.length > 0) return child as ReadonlyArray<Transition<never, R>>
          if (cancellation.invocation.method !== "message") return []
          const execution = state.execution as CodeProjectionState
          for (const [execId, dispatch] of execution.dispatches) {
            if (execution.settled.has(execId)) continue
            if (String((dispatch as { readonly turn?: unknown }).turn) !== cancellation.invocation.id) continue
            if (eventEpochOf(dispatch) !== cancellation.invocation.epoch) continue
            return codeCancellationTransition<R>(execId, cancellation)
          }
          return []
        },
        output: (state) => {
          const children = childMachine.output(state.children)
          const packages = children.view.packages
          const execution = codeReactorFor(
            options.policy ?? {},
            packages as unknown as ReadonlyArray<Package<ComponentR>>
          )
          return {
            view: {
              system: [dynamicSystem?.(Chunk.toReadonlyArray(state.history)) ?? staticSystem ?? codeSystemFor(packages)],
              tools: [{
                spec: executeTool(summaryMaxLength),
                serve: (call: PendingCall, current: ReadonlyArray<Event>, answer: Answer) => serveCode(current, call, answer)
              }],
              context: [],
              output: []
            },
            transitions: [
              ...(execution.output(state.execution) as ReadonlyArray<Transition<never, R>>),
              ...(children.transitions as ReadonlyArray<Transition<never, R>>)
            ]
          }
        }
      }) as AgentComponent<R>
  return inheritComponentContract<AgentView, R>(component, combined)
}
