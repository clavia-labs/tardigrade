import { Clock, Effect } from "effect"
import { transition } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/event"
import { toolReturned } from "../events"
import type { ToolSpec } from "../request"
import type { AgentComponent, AgentTool } from "../runtime/agent"

// NativeTool is one named tool whose effect returns its model-visible result.
export interface NativeTool<R = never> {
  readonly spec: ToolSpec
  readonly run: (input: unknown, context: { readonly callId: string; readonly turn?: string }) => Effect.Effect<unknown, never, R>
}

// toolList derives fixed tool bindings that pair every specification with its effect handler.
export const toolList = <R = never>(
  tools: ReadonlyArray<NativeTool<R>>,
  system: string | ((log: ReadonlyArray<Event>) => string) = ""
): AgentComponent<R> => ({
  name: "tools",
  derive: (log) => ({
    info: {
      system: [
        (typeof system === "function" ? system(log) : system) ||
          `You act on the world by calling the tools available to you: ${tools.map((tool) => tool.spec.name).join(", ")}.`
      ],
      tools: tools.map((tool): AgentTool<R> => ({
        spec: tool.spec,
        serve: (call) => {
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
      })) as ReadonlyArray<AgentTool<unknown>>,
      context: []
    },
    transitions: []
  })
})
