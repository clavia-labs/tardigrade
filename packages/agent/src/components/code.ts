import { Clock, Effect } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { transition, type Transition } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { codeDispatched, codeKeys } from "@clavia/tardigrade-code/events"
import { codeReactorFor, type CodePolicy } from "@clavia/tardigrade-code/execute"
import type { Package, PackageRequirements } from "@clavia/tardigrade-code/packages"
import type { AgentComponent } from "../runtime/agent"
import type { Answer, PendingCall } from "../runtime/tools"
import type { ToolSpec } from "../request"

const EXECUTE_TOOL: ToolSpec = {
  name: "execute",
  description:
    "Run JavaScript against the connected packages. Packages are objects in scope; await their methods and end with `return <value>`. The returned value comes back as this call's result, and console output comes back beside it as `logs` (capped; return the value you need, print to inspect).",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string", description: "The JavaScript body to run." } },
    required: ["code"],
    additionalProperties: false
  }
}

const CODE_SYSTEM_LEAD = "You act on the world by calling the execute tool with JavaScript; the packages in scope are:"
export const CODE_SYSTEM = `${CODE_SYSTEM_LEAD}\nnone`

// codeSystemFor names each package on its own line as name and description.
export const codeSystemFor = (packages: ReadonlyArray<Package<unknown>>): string =>
  `${CODE_SYSTEM_LEAD}\n${packages.length === 0 ? "none" : packages.map((p) => `${p.name}: ${p.description}`).join("\n")}`

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

// codeModeFor derives the execute tool and code transitions from the same log and package scope.
export const codeModeFor = <
  const P extends ReadonlyArray<Package<never>> | ReadonlyArray<Package<unknown>> = readonly []
>(
  options: {
    readonly policy?: Partial<CodePolicy>
    readonly system?: string | ((log: ReadonlyArray<Event>) => string)
    readonly packages?: P
  } = {}
): AgentComponent<KeyValueStore.KeyValueStore | PackageRequirements<P[number]>> => {
  const packages = (options.packages ?? []) as unknown as P
  const reactor = codeReactorFor(options.policy ?? {}, packages)
  return {
    name: "code",
    keys: codeKeys,
    derive: (log) => ({
      view: {
        system: [typeof options.system === "function" ? options.system(log) : options.system ?? codeSystemFor(packages as ReadonlyArray<Package<unknown>>)],
        tools: [{ spec: EXECUTE_TOOL, serve: (call, current, answer) => serveCode(current, call, answer) }],
        context: [],
        output: []
      },
      transitions: reactor(log)
    })
  }
}

export const codeMode: AgentComponent<KeyValueStore.KeyValueStore> = codeModeFor()
