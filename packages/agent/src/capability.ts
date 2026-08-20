import { Clock, Effect } from "effect"
import type { KeyValueStore } from "effect/unstable/persistence"
import { actor, transition, type Actor, type Reactor, type Self } from "@clavia/tardigrade-core/actor"
import { composeKeys, type KeyFragment } from "@clavia/tardigrade-core/event-log"
import { messageKeys } from "@clavia/tardigrade-core/message"
import type { Event } from "@clavia/tardigrade-core/event"
import { codeDispatched, codeKeys } from "@clavia/tardigrade-code/events"
import { codeReactorFor, type CodePolicy } from "@clavia/tardigrade-code/execute"
import type { Package, PackageRequirements } from "@clavia/tardigrade-code/packages"
import type { Router } from "@clavia/tardigrade-core/router"
import type { ToolSpec } from "./request"
import { agentKeys, toolReturned } from "./events"
import { inferReactorFor, type Infer, type InferPolicy } from "./infer"
import { toolsReactorFrom, type Answer, type PendingCall, type Serve } from "./tools"
import { budgetReactorFor, type BudgetPolicy } from "./budget"
import { replyReactor } from "./reply"
import { compactionReactorFor, type ContextPolicy } from "./compaction"
import type { AgentR } from "./turn"

// A Capability is one component of an agent: it provides the model its context and services
// the calls that come back, as one value. `tools`, `system`, and `context` are the capability's
// render into the model's request, re-derived from the log each attempt; `reactors` and `serve`
// are its handlers. Mounting a capability is adding it to the agentOf list; there is no second
// place to update.
//
// Every field but `name` is optional, because capabilities come in shapes: a policy capability
// (reply, budget, compaction) has reactors with nothing to show; a tool-list capability has
// tools and a serve with no lane of its own; code mode has all four.
export interface Capability<R = never> {
  // The capability's name, for the collision error and span attributes.
  readonly name: string
  // The capability's alphabet fragment. agentOf composes fragments the way composeKeys does,
  // and a prefix collision is the same construction-time error.
  readonly keys?: KeyFragment
  // The reactors that settle this capability's work.
  readonly reactors?: ReadonlyArray<Reactor<R>>
  // tools derives what the model is shown, a projection of the log like any other: a constant
  // capability ignores its argument, a gated one filters by what has happened.
  // The composed tools are what the infer reactor hands the model
  // binding per attempt; nothing about tools lives in ModelConfig.
  readonly tools?: (log: ReadonlyArray<Event>) => ReadonlyArray<ToolSpec>
  // The system fragment explaining the tools, a projection of the log like `tools`: a constant
  // string is the constant projection, and a function derives the fragment from what has
  // happened. Fragments join in agentOf order.
  readonly system?: string | ((log: ReadonlyArray<Event>) => string)
  // What the render truncates and where. The capability that applies a context policy to its
  // reactor states the same one here, so the binding renders against the policy the guard
  // holds and the two cannot drift (compactionFor).
  readonly context?: Partial<ContextPolicy>
  // serve returns the transitions one call owes: an empty array while the world still works,
  // undefined when the call names no tool of this capability (agentOf asks the next capability,
  // and the reactor answers unknown-tool when every capability declines). The reactor owns the
  // key and the turn stamp through `answer`.
  readonly serve?: Serve<R>
}

// renderOf is the composed request half for one derivation: what the model would be shown over
// this log, and the context policy the render obeys. The infer reactor is its one production
// reader; tests read it directly. Context fields merge in mount order, last statement wins.
export const renderOf = <R>(
  capabilities: ReadonlyArray<Capability<R>>,
  log: ReadonlyArray<Event>
): { readonly system: string; readonly tools: ReadonlyArray<ToolSpec>; readonly context: Partial<ContextPolicy> } => ({
  system: capabilities
    .map((c) => (typeof c.system === "function" ? c.system(log) : c.system))
    .filter((s): s is string => s !== undefined && s !== "")
    .join("\n"),
  tools: capabilities.flatMap((c) => c.tools?.(log) ?? []),
  context: Object.assign({}, ...capabilities.map((c) => c.context ?? {})) as Partial<ContextPolicy>
})

// RequirementsOf extracts one capability's R, so a mixed list infers the union of what its
// members need rather than failing on the first element's R.
type RequirementsOf<C> = C extends Capability<infer R> ? R : never

// agentOf mounts capabilities into an actor. The infer and call-routing reactors are the
// runtime of the component model: agentOf injects them, and they are never listed as
// capabilities, the way a component tree does not list the renderer. The canonical inbound and
// the agent alphabet are the runtime's own key table; capability fragments compose beside them,
// and a prefix collision is composeKeys' construction-time error. Two capabilities deriving the
// same tool name collide at construction too, checked over the empty log (a log-gated duplicate
// still routes to the first capability that recognizes it).
export const agentOf = <const Caps extends ReadonlyArray<Capability<never> | Capability<AgentR>>>(
  caps: Caps,
  policy: Partial<InferPolicy> = {}
): Actor<AgentR | RequirementsOf<Caps[number]>> => {
  const capabilities = caps as ReadonlyArray<Capability<AgentR | RequirementsOf<Caps[number]>>>
  const named = new Map<string, string>()
  for (const c of capabilities) {
    for (const t of c.tools?.([]) ?? []) {
      const holder = named.get(t.name)
      if (holder !== undefined) throw new Error(`tool "${t.name}" declared by capabilities ${holder} and ${c.name}`)
      named.set(t.name, c.name)
    }
  }
  const serve = (call: PendingCall, log: ReadonlyArray<Event>, answer: Answer) => {
    for (const c of capabilities) {
      const served = c.serve?.(call, log, answer)
      if (served !== undefined) return served
    }
    return undefined
  }
  return actor<AgentR | RequirementsOf<Caps[number]>>(
    [
      inferReactorFor(policy, (log) => renderOf(capabilities, log)),
      toolsReactorFrom(serve, (log) => renderOf(capabilities, log).tools),
      ...capabilities.flatMap((c) => c.reactors ?? [])
    ],
    composeKeys(messageKeys, agentKeys, ...capabilities.flatMap((c) => (c.keys === undefined ? [] : [c.keys])))
  )
}

// EXECUTE_TOOL is code mode's one work tool: the model acts by writing JavaScript against the
// packages in scope.
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

// CODE_SYSTEM is code mode's system fragment with nothing in scope: it names the tool the model
// acts with and says the scope is empty. codeSystemFor renders the same sentence over the
// packages an assembly passed, so what the model reads is derived from the same values the code
// reactor mounts (capability.test.ts, "a mounted package names itself in the system fragment").
const CODE_SYSTEM_LEAD = "You act on the world by calling the execute tool with JavaScript; the packages in scope are:"
export const CODE_SYSTEM = `${CODE_SYSTEM_LEAD}\nnone`

// codeSystemFor names each package on its own line, `name: description`. An empty list reads
// "none", which is CODE_SYSTEM.
export const codeSystemFor = (packages: ReadonlyArray<Package<unknown>>): string =>
  `${CODE_SYSTEM_LEAD}\n${packages.length === 0 ? "none" : packages.map((p) => `${p.name}: ${p.description}`).join("\n")}`

// settleFor reads one execution's outcome, once the code reactor has recorded it.
const settleFor = (
  log: ReadonlyArray<Event>,
  callId: string
): { result?: unknown; error?: string; logs?: ReadonlyArray<string> } | undefined => {
  const settle = log.find((e) => e.type === "CodeSettled" && String((e as { execId?: unknown }).execId) === callId) as
    | { result?: unknown; error?: unknown; logs?: ReadonlyArray<string>; tmp?: unknown; size?: unknown; preview?: unknown; note?: unknown }
    | undefined
  if (settle === undefined) return undefined
  // Captured console output rides along: the model reads what its code printed, beside the
  // result (the print-to-inspect habit; packages/code/src/sandbox.ts, SandboxResult.logs).
  const logs = settle.logs !== undefined && settle.logs.length > 0 ? { logs: settle.logs } : {}
  if (settle.error !== undefined) return { error: String(settle.error), ...logs }
  // A settle over the spill bound carries a pointer instead of the value: the pointer IS the
  // result the model reads, its preview and note naming the ref and the call that loads it
  // (turn.test.ts, "a spilled settle").
  if (settle.tmp !== undefined) {
    return { result: { tmp: settle.tmp, size: settle.size, preview: settle.preview, note: settle.note }, ...logs }
  }
  return { result: settle.result, ...logs }
}

const codeServe: Serve = (call, log, answer) => {
  if (call.name !== "execute") return undefined
  const stamp = call.turn === undefined ? {} : { turn: call.turn }
  // Dispatched already: the answer exists once the code reactor settles the execution.
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

// codeModeFor is the code-execution capability: one `execute` tool, served by dispatching to
// the code reactor and answered from its settle. Every option has a default, so the bare call
// is the whole capability on defaults. `packages` are the values the code may name; the
// capability's R is the spill store plus what those packages need, and the model's fragment is
// derived from the same values, so what the code can call and what the model is told cannot
// drift. `policy` is the code lane's own (packages/code/src/execute.ts, CodePolicy). `system`
// replaces the derived fragment, as a string or as a projection of the log, for a host that
// names its scope from its own events (capability.test.ts, "codeModeFor takes a system
// fragment"). `packages` infers as a tuple, so a mixed list gives the union of what its members
// require (capability.test.ts, "a mounted package's requirements ride the capability's type").
export const codeModeFor = <
  const P extends ReadonlyArray<Package<never>> | ReadonlyArray<Package<unknown>> = readonly []
>(
  options: {
    readonly policy?: Partial<CodePolicy>
    readonly system?: Capability["system"]
    readonly packages?: P
  } = {}
): Capability<KeyValueStore.KeyValueStore | PackageRequirements<P[number]>> => {
  const packages = (options.packages ?? []) as unknown as P
  return {
    name: "code",
    keys: codeKeys,
    reactors: [codeReactorFor(options.policy ?? {}, packages)],
    tools: () => [EXECUTE_TOOL],
    system: options.system ?? codeSystemFor(packages as ReadonlyArray<Package<unknown>>),
    serve: codeServe
  }
}

// codeMode is that capability on defaults, with nothing in scope: the library default work
// surface.
export const codeMode: Capability<KeyValueStore.KeyValueStore> = codeModeFor()

// A NativeTool is one named tool the model calls directly: its wire shape, and the effect that
// runs it. The effect's failures are the tool's own answer, so a tool that throws returns an
// error the model reads rather than killing the turn.
export interface NativeTool<R = never> {
  readonly spec: ToolSpec
  readonly run: (input: unknown, context: { readonly callId: string; readonly turn?: string }) => Effect.Effect<unknown, never, R>
}

// toolList is a fixed list of named tools, the shape every provider's tool calling takes and
// the shape a replicated harness is measured on: each call runs its tool and records the
// return, no lane of its own.
export const toolList = <R = never>(tools: ReadonlyArray<NativeTool<R>>, system: Capability["system"] = ""): Capability<R> => {
  const table = new Map(tools.map((t) => [t.spec.name, t]))
  return {
    name: "tools",
    system:
      system === ""
        ? `You act on the world by calling the tools available to you: ${tools.map((t) => t.spec.name).join(", ")}.`
        : system,
    tools: () => tools.map((t) => t.spec),
    serve: (call, _log, _answer) => {
      const tool = table.get(call.name)
      if (tool === undefined) return undefined
      const stamp = call.turn === undefined ? {} : { turn: call.turn }
      return [
        transition({
          key: `tr:${call.callId}`,
          input: { callId: call.callId, arguments: call.arguments, turn: call.turn },
          act: (input) =>
            Effect.gen(function* () {
              const result = yield* tool.run(input.arguments, { callId: input.callId, ...(input.turn === undefined ? {} : { turn: input.turn }) })
              const at = yield* Clock.currentTimeMillis
              return [toolReturned({ callId: input.callId, result, ...stamp, at })]
            })
        })
      ]
    }
  }
}

// The policy capabilities: behavior with nothing to show. Their keys live in the runtime's own
// agent alphabet, so they carry none. Their R names what each reactor needs, all within the
// AgentR the runtime already requires.
export const budgetFor = (policy: Partial<BudgetPolicy>): Capability => ({
  name: "budget",
  reactors: [budgetReactorFor(policy)]
})
export const budget: Capability = budgetFor({})

// compactionFor states its policy twice on purpose: to its reactor (the guard) and to the
// render (`context`), so the binding truncates against the same numbers the guard fires on.
export const compactionFor = (policy: Partial<ContextPolicy>): Capability<Infer> => ({
  name: "compaction",
  reactors: [compactionReactorFor(policy)],
  context: policy
})
export const compaction: Capability<Infer> = compactionFor({})

export const reply: Capability<Router | Self> = { name: "reply", reactors: [replyReactor] }
