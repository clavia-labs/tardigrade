import { Clock, Effect } from "effect"
import { effect } from "@clavia/tardigrade-core/runtime"
import { component, legacyComponent } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { toolReturned } from "../log/events"
import type { ToolSpec } from "../inference/request"
import type { AgentComponent, AgentTool } from "../runtime/composition"

// NativeTool describes one named tool whose effect returns its model-visible result.
export interface NativeTool<R = never> {
  readonly spec: ToolSpec
  readonly run: (input: unknown, context: { readonly callId: string; readonly turn?: string; readonly signal: AbortSignal }) => Effect.Effect<unknown, never, R>
}

// tool derives fixed tool bindings from their specifications and effect handlers.
export const tool = <R = never>(
  bindings: NativeTool<R> | ReadonlyArray<NativeTool<R>>,
  system: string | ((log: ReadonlyArray<Event>) => string) = ""
): AgentComponent<R> => {
  const tools: ReadonlyArray<NativeTool<R>> = Array.isArray(bindings)
    ? bindings as ReadonlyArray<NativeTool<R>>
    : [bindings as NativeTool<R>]
  const derive = (instruction: string) => ({
      view: {
        system: [
          instruction ||
            `You act on the world by calling the tools available to you: ${tools.map((tool) => tool.spec.name).join(", ")}.`
        ],
        tools: tools.map((tool): AgentTool<R> => ({
          spec: tool.spec,
          serve: (call) => {
            const stamp = call.turn === undefined ? {} : { turn: call.turn }
            return [
              effect({
                key: `tr:${call.callId}`,
                ...(call.turn === undefined
                  ? {}
                  : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }),
                input: { callId: call.callId, arguments: call.arguments, turn: call.turn },
                act: (input, signal) =>
                  Effect.gen(function* () {
                    const result = yield* tool.run(input.arguments, {
                      callId: input.callId,
                      ...(input.turn === undefined ? {} : { turn: input.turn }),
                      signal
                    })
                    const at = yield* Clock.currentTimeMillis
                    return [toolReturned({ callId: input.callId, result, ...stamp, at })]
                  })
              })
            ]
          }
        })) as ReadonlyArray<AgentTool<unknown>>,
        context: [],
        output: []
      },
      transitions: []
    })
  return typeof system === "function"
    ? legacyComponent({ name: "tools", derive: (log) => derive(system(log)) })
    : component({
        name: "tools",
        initial: () => system,
        step: (state: string) => state,
        output: derive
      })
}

// LATER(0.20.0): Remove toolList after callers migrate to tool.
export const toolList = <R = never>(
  bindings: NativeTool<R> | ReadonlyArray<NativeTool<R>>,
  system: string | ((log: ReadonlyArray<Event>) => string) = ""
): AgentComponent<R> => tool(bindings, system)
