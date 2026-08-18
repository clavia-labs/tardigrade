import { actor, type Actor, type Reactor, type Self, type Transition } from "@tardigrade/core/actor"
import { composeKeys } from "@tardigrade/core/event-log"
import { messageKeys } from "@tardigrade/core/message"
import type { Event } from "@tardigrade/core/event"
import type { KeyFragment } from "@tardigrade/core/event-log"
import { codeKeys } from "@tardigrade/code/events"
import { codeReactor } from "@tardigrade/code/execute"
import type { ToolSpec } from "./request"
import { codeSurface, nativeSurface, type Answer, type NativeTool, type PendingCall } from "./surface"
import { agentKeys } from "./events"
import type { Router } from "@tardigrade/core/router"
import { inferReactorFor, type Infer, type InferPolicy } from "./infer"
import { toolsReactorFrom } from "./tools"
import { budgetReactor } from "./budget"
import { replyReactor } from "./reply"
import { compactionReactor } from "./compaction"
import type { AgentR } from "./turn"

// A Capability is one component of an agent: what the model is shown and how that work settles,
// as one value. `tools` and `system` are the capability's render into the model's context,
// re-derived from the log each attempt, and `reactors` and `serve` are its handlers. Mounting a
// capability is adding it to the actorOf list; there is no second place to update.
//
// Every field but `name` is optional, because capabilities come in shapes: a policy capability
// (reply, budget, compaction) has reactors with nothing to show; a tool-table capability has
// tools and a serve with no lane of its own; code mode has all four.
export interface Capability<R = never> {
  // The capability's name, for the collision error and span attributes.
  readonly name: string
  // The capability's alphabet fragment. actorOf composes fragments the way composeKeys does,
  // and a prefix collision is the same construction-time error.
  readonly keys?: KeyFragment
  // The reactors that settle this capability's work.
  readonly reactors?: ReadonlyArray<Reactor<R>>
  // tools derives what the model is shown, a projection of the log like any other: a constant
  // capability ignores its argument, a gated one filters by what has happened
  // (docs/how-to/gate-tools.md). The composed tools are what the infer reactor hands the model
  // binding per attempt; nothing about tools lives in ModelConfig.
  readonly tools?: (log: ReadonlyArray<Event>) => ReadonlyArray<ToolSpec>
  // The system fragment explaining the tools. Fragments join in actorOf order.
  readonly system?: string
  // serve returns the transitions one call owes: an empty array while the world still works,
  // undefined when the call names no tool of this capability (actorOf asks the next capability,
  // and the reactor answers unknown-tool when every capability declines). The reactor owns the
  // key and the turn stamp through `answer`.
  readonly serve?: (
    call: PendingCall,
    log: ReadonlyArray<Event>,
    answer: Answer
  ) => ReadonlyArray<Transition<never, R>> | undefined
}

// renderOf is the composed system and tools for one derivation: what the model would be shown
// over this log. The infer reactor is its one production reader; tests read it directly.
export const renderOf = <R>(
  capabilities: ReadonlyArray<Capability<R>>,
  log: ReadonlyArray<Event>
): { readonly system: string; readonly tools: ReadonlyArray<ToolSpec> } => ({
  system: capabilities
    .map((c) => c.system)
    .filter((s): s is string => s !== undefined && s !== "")
    .join("\n"),
  tools: capabilities.flatMap((c) => c.tools?.(log) ?? [])
})

// actorOf mounts capabilities into an actor. The infer and call-routing reactors are the
// runtime of the component model: actorOf injects them, and they are never listed as
// capabilities, the way a component tree does not list the renderer. The canonical inbound and
// the agent alphabet are the runtime's own key table; capability fragments compose beside them,
// and a prefix collision is composeKeys' construction-time error. Two capabilities deriving the
// same tool name collide at construction too, checked over the empty log (a log-gated duplicate
// still routes to the first capability that recognizes it).
// RequirementsOf extracts one capability's R, so a mixed list infers the union of what its
// members need rather than failing on the first element's R.
type RequirementsOf<C> = C extends Capability<infer R> ? R : never

export const actorOf = <const Caps extends ReadonlyArray<Capability<never> | Capability<AgentR>>>(
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

// codeMode is the code-execution capability: one `execute` tool, served by dispatching to the
// code reactor and answered from its settle. The library default.
const cs = codeSurface()
export const codeMode: Capability = {
  name: "code",
  keys: codeKeys,
  reactors: [codeReactor],
  tools: () => cs.tools,
  system: cs.system,
  serve: cs.serve
}

// toolList is a fixed table of named tools, the shape every provider's tool calling takes and
// the shape a replicated harness is measured on: each call runs its tool and records the
// return, no lane of its own.
export const toolList = <R = never>(tools: ReadonlyArray<NativeTool<R>>, system = ""): Capability<R> => {
  const ns = nativeSurface(tools, system)
  return { name: "tools", tools: () => ns.tools, system: ns.system, serve: ns.serve }
}

// The policy capabilities: behavior with nothing to show. Their keys live in the runtime's own
// agent alphabet, so they carry none. Their R names what each reactor needs, all within the
// AgentR the runtime already requires.
export const reply: Capability<Router | Self> = { name: "reply", reactors: [replyReactor] }
export const budget: Capability = { name: "budget", reactors: [budgetReactor] }
export const compaction: Capability<Infer> = { name: "compaction", reactors: [compactionReactor] }
