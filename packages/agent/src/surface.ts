import { Clock, Effect } from "effect"
import { transition, type Transition } from "@flamecast/core/actor"
import type { Event } from "@flamecast/core/event"
import { codeDispatched } from "@flamecast/code/events"
import type { Packages } from "@flamecast/code/packages"
import type { Sandbox } from "@flamecast/code/sandbox"
import type { Tmp } from "@flamecast/code/tmp"
import { toolReturned } from "./events"
import type { ToolSpec } from "./request"

export type CodeLaneR = Packages | Sandbox | Tmp

// A ToolSurface is the agent's work half: the tools the model may call, the system text that
// explains them, and how one call becomes events. The turn loop, the budget wall, the answer
// contract, and compaction are policy and stay in the reactors; only the work surface varies.
//
// Code mode is the default (`codeSurface`), not the only option. An agent whose worth is being
// measured against a fixed tool table (a benchmark replicating another harness) hands its own
// tools to `nativeSurface` and keeps every other behavior, so the surface under test is the one
// the comparison names rather than the one this library prefers.
//
// One surface serves two consumers: the actor takes `serve` (tools.ts), and the model binding
// takes `system` and `tools` (request.ts). Bundling them keeps a caller from pairing the prompt
// of one surface with the dispatch of another.

// PendingCall is the call being served: the head unanswered `ToolCalled`.
export interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly turn?: string
}

// Answer mints the transition that ends a call with a result. The reactor owns the key and the
// turn stamp, so a surface cannot key a tool answer wrongly.
export type Answer = (result: unknown) => Transition<never, never>

export interface ToolSurface<R = never> {
  // The system text describing this surface's tools. It joins the agent's own instructions.
  readonly system: string
  readonly tools: ReadonlyArray<ToolSpec>
  // serve returns the transitions this call owes: an empty array while the world is still
  // working, and undefined when the call names no tool on this surface (the reactor answers
  // with an unknown-tool error). It is a projection, so it never reads a clock.
  readonly serve: (
    call: PendingCall,
    log: ReadonlyArray<Event>,
    answer: Answer
  ) => ReadonlyArray<Transition<never, R>> | undefined
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

const CODE_SYSTEM = (packages: string): string =>
  `You act on the world by calling the execute tool with JavaScript; the packages in scope are:\n${packages}`

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
  // A settle over TMP_BYTES carries a pointer instead of the value (packages/code/src/execute.ts).
  // The pointer IS the result the model reads: its preview and its note name the ref and the
  // call that loads it. Reading `result` alone answers a spilled call with `{}`, so the model
  // learns neither what it computed nor that anything is there to fetch, and it re-runs the work
  // it already did (turn.test.ts, "a spilled settle").
  if (settle.tmp !== undefined) {
    return { result: { tmp: settle.tmp, size: settle.size, preview: settle.preview, note: settle.note }, ...logs }
  }
  return { result: settle.result, ...logs }
}

// codeSurface is one `execute` tool, dispatched to the code reactor and answered from its settle.
// The surface's R is the code lane: `agentFor` cannot wear it, because that actor has no code reactor.
// `packagesInScope` is the rendered package list the system text names.
export const codeSurface = (packagesInScope = "none"): ToolSurface<CodeLaneR> => ({
  system: CODE_SYSTEM(packagesInScope),
  tools: [EXECUTE_TOOL],
  serve: (call, log, answer) => {
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
})

// A NativeTool is one named tool the model calls directly: its wire shape, and the effect that
// runs it. The effect's failures are the tool's own answer, so a tool that throws returns an
// error the model reads rather than killing the turn.
export interface NativeTool<R = never> {
  readonly spec: ToolSpec
  readonly run: (input: unknown, context: { readonly callId: string; readonly turn?: string }) => Effect.Effect<unknown, never, R>
}

// nativeSurface serves a fixed table of named tools, the shape every provider's tool calling
// takes and the shape a replicated harness is measured on. One transition per call: the act runs
// the tool and records its return, so the surface needs no lane of its own.
export const nativeSurface = <R = never>(tools: ReadonlyArray<NativeTool<R>>, system = ""): ToolSurface<R> => {
  const table = new Map(tools.map((t) => [t.spec.name, t]))
  return {
    system:
      system === ""
        ? `You act on the world by calling the tools available to you: ${tools.map((t) => t.spec.name).join(", ")}.`
        : system,
    tools: tools.map((t) => t.spec),
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
