import { Clock, Effect } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { transition, type Transition } from "@clavia/tardigrade-core/actor"
import { composeComponents, type ComponentRequirements } from "@clavia/tardigrade-core/component"
import type { Event } from "@clavia/tardigrade-core/event"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/event-log"
import { codeDispatched, codeKeys } from "@clavia/tardigrade-code/events"
import { codeReactorFor, type CodePolicy } from "@clavia/tardigrade-code/execute"
import { renderShape, renderSignature } from "@clavia/tardigrade-code/contract"
import {
  CODE_VIEW_ALGEBRA,
  type CodeComponent,
  type Package
} from "@clavia/tardigrade-code/packages"
import type { AgentComponent } from "../runtime/agent"
import type { Answer, PendingCall } from "../runtime/tools"
import type { ToolSpec } from "../request"

const EXECUTE_TOOL: ToolSpec = {
  name: "execute",
  description:
    "Run an async JavaScript body against the connected packages. Package objects are already in scope; await their methods and end with `return <value>`. The returned value comes back as this call's result, and console output comes back beside it as `logs` (capped; return the value you need, print to inspect).",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "The JavaScript body to run." } },
    required: ["code"],
    additionalProperties: false
  }
}

const CODE_SYSTEM_LEAD = "The execute tool runs an async JavaScript body with the connected packages already in scope as objects. Use ordinary JavaScript to coordinate calls. The calling pattern is `const value = await package.method(input); return value`. The packages in scope are:"
export const CODE_SYSTEM = `${CODE_SYSTEM_LEAD}\nnone`

// codeSystemFor names each package and renders every documented method's input and output schema.
// The declaration shown to the model is the same MethodDoc the dispatch funnel validates, so code
// generation and execution share one calling convention (packages/code/src/contract.ts).
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
  const stamp = call.turn === undefined ? {} : { turn: call.turn }
  if (log.some((e) => e.type === "CodeDispatched" && String((e as { execId?: unknown }).execId) === call.callId)) {
    const outcome = settleFor(log, call.callId)
    return outcome === undefined ? [] : [answer(outcome)]
  }
  const code = String((call.arguments as { code?: unknown } | undefined)?.code ?? "")
  return [
    transition({
      key: `cd:${call.callId}`,
      input: { execId: call.callId, code },
      act: (input) =>
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return [codeDispatched({ execId: input.execId, code: input.code, ...stamp, at })]
        })
    })
  ]
}

export interface CodeModeOptions {
  readonly policy?: Partial<CodePolicy>
  readonly system?: string | ((log: ReadonlyArray<Event>) => string)
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
): AgentComponent<KeyValueStore.KeyValueStore | ComponentRequirements<Cs[number]>> => {
  type ComponentR = ComponentRequirements<Cs[number]>
  type R = KeyValueStore.KeyValueStore | ComponentR
  const combined = composeComponents("code.children", CODE_VIEW_ALGEBRA, components) as CodeComponent<ComponentR>
  const packagesOf = (log: ReadonlyArray<Event>): ReadonlyArray<Package<ComponentR>> =>
    combined.derive(log).view.packages as unknown as ReadonlyArray<Package<ComponentR>>

  codeReactorFor(options.policy ?? {}, packagesOf([]))
  return {
    name: "code",
    keys: rootKeys(combined.keys),
    derive: (log) => {
      const children = combined.derive(log)
      const packages = children.view.packages
      const execution = codeReactorFor(
        options.policy ?? {},
        packages as unknown as ReadonlyArray<Package<ComponentR>>
      )
      return {
        view: {
          system: [typeof options.system === "function" ? options.system(log) : options.system ?? codeSystemFor(packages)],
          tools: [{ spec: EXECUTE_TOOL, serve: (call, current, answer) => serveCode(current, call, answer) }],
          context: [],
          output: []
        },
        transitions: [
          ...(execution(log) as ReadonlyArray<Transition<never, R>>),
          ...(children.transitions as ReadonlyArray<Transition<never, R>>)
        ]
      }
    }
  }
}
