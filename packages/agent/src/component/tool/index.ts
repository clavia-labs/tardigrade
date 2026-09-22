import { toolComponent, type ToolComponent, toolConcurrencyOf, type ToolConcurrency } from "./machine"
import { Clock, Effect } from "effect"
import { component, legacyComponent } from "@clavia/tardigrade-core/actor"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { toolReturned } from "../../log/events"
import type { ToolSpec } from "../../model/request"
import type { ToolOffer } from "../view"

// NativeTool describes one named tool whose effect returns its model-visible result.
export interface NativeTool<R = never> {
  readonly concurrency?: ToolConcurrency
  readonly spec: ToolSpec
  readonly run: (
    input: unknown,
    context: { readonly callId: string; readonly turn?: string; readonly signal: AbortSignal }
  ) => Effect.Effect<unknown, never, R>
}

// tool derives fixed tool bindings from their specifications and effect handlers.
export const tool = <R = never>(
  bindings: NativeTool<R> | ReadonlyArray<NativeTool<R>>,
  system: string | ((log: ReadonlyArray<Event>) => string) = "",
  options: { readonly name?: string } = {}
): ToolComponent<R> => {
  const tools: ReadonlyArray<NativeTool<R>> = Array.isArray(bindings)
    ? (bindings as ReadonlyArray<NativeTool<R>>)
    : [bindings as NativeTool<R>]
  const offers = tools.map((tool): ToolOffer<R> => ({
    spec: tool.spec,
    concurrency: toolConcurrencyOf(tool.concurrency),
    serve: (call) => {
      const stamp = call.turn === undefined ? {} : { turn: call.turn }
      return [
        call.context.effect("answer", {
          concurrent: true,
          ...(call.turn === undefined
            ? {}
            : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }),
          input: { callId: call.callId, arguments: call.arguments, turn: call.turn },
          act: (input, { signal }) =>
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
  }))
  const derive = (instruction: string) => ({
    view: {
      system: [
        instruction ||
          `You act on the world by calling the tools available to you: ${tools.map((tool) => tool.spec.name).join(", ")}.`
      ],
      tools: offers.map(({ spec, concurrency }) => ({ spec, ...(concurrency === undefined ? {} : { concurrency }) })),
      context: [],
      output: []
    },
    interactions: { tools: () => offers },
    transitions: []
  })
  const child =
    typeof system === "function"
      ? legacyComponent({ name: options.name ?? "tools", derive: (log) => ({ ...derive(system(log)) }) })
      : component({
          name: options.name ?? "tools",
          initial: () => system,
          step: (state: string) => state,
          output: (state) => ({ ...derive(state) })
        })
  return toolComponent(child)
}

// LATER(0.20.0): Remove toolList after callers migrate to tool.
export const toolList = <R = never>(
  bindings: NativeTool<R> | ReadonlyArray<NativeTool<R>>,
  system: string | ((log: ReadonlyArray<Event>) => string) = "",
  options: { readonly name?: string } = {}
): ToolComponent<R> => tool(bindings, system, options)

export { tools, type ToolsOptions } from "./packages"
