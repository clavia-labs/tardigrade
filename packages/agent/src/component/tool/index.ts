import { toolComponent, type ToolComponent, toolConcurrencyOf, type ToolConcurrency } from "./machine"
import { Clock, Effect } from "effect"
import { component, legacyComponent, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import type { CodeComponent } from "@clavia/tardigrade-code/package/definition"
import type { KeyValueStore } from "effect/unstable/persistence"
import { tools as packageTools, type ToolsOptions } from "./packages"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog } from "@clavia/tardigrade-core/log"
import { toolReturned } from "../../log/events"
import type { ToolSpec } from "../../model/request"
import type { ToolOffer } from "../view"

// NativeTool describes one named tool whose effect returns its model-visible result.
export interface NativeTool<R = never> {
  readonly concurrency?: ToolConcurrency
  readonly spec: ToolSpec
  readonly run: (
    input: unknown,
    context: {
      readonly callId: string
      readonly turn?: string
      readonly signal: AbortSignal
      // readEvents reads the committed actor log when its effect runs (machine.test.ts).
      readonly readEvents: () => Effect.Effect<ReadonlyArray<Event>>
    }
  ) => Effect.Effect<unknown, never, R>
}

const nativeTools = <R = never>(
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
              const log = yield* EventLog
              const result = yield* tool.run(input.arguments, {
                callId: input.callId,
                ...(input.turn === undefined ? {} : { turn: input.turn }),
                signal,
                readEvents: () => log.read
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

// tools exposes native bindings or child package methods through the tool execution boundary.
export function tools<R = never>(
  bindings: NativeTool<R> | ReadonlyArray<NativeTool<R>>,
  system?: string | ((log: ReadonlyArray<Event>) => string),
  options?: { readonly name?: string }
): ToolComponent<R>
export function tools<const Cs extends ReadonlyArray<CodeComponent<unknown>>>(
  children: Cs,
  options?: ToolsOptions
): ToolComponent<ComponentRequirements<Cs[number]> | KeyValueStore.KeyValueStore>
export function tools(
  input: NativeTool<unknown> | ReadonlyArray<NativeTool<unknown> | CodeComponent<unknown>>,
  configuration: string | ((log: ReadonlyArray<Event>) => string) | ToolsOptions = "",
  options: { readonly name?: string } = {}
): ToolComponent<unknown> {
  const entries = Array.isArray(input) ? input : [input]
  const isNative = (entry: NativeTool<unknown> | CodeComponent<unknown>): entry is NativeTool<unknown> =>
    "spec" in entry && "run" in entry
  if (entries.every(isNative) && typeof configuration !== "object") {
    return nativeTools(entries, configuration, options)
  }
  if (entries.some(isNative) || typeof configuration === "function" || configuration !== "" && typeof configuration !== "object") {
    throw new Error("tools accepts either native bindings or package components with their corresponding options")
  }
  return packageTools(entries as ReadonlyArray<CodeComponent<unknown>>, typeof configuration === "object" ? configuration : {})
}

/** @deprecated Use tools instead. */
export const tool: typeof nativeTools = nativeTools

/** @deprecated Use tools instead. */
export const toolList: typeof nativeTools = nativeTools

export type { ToolsOptions } from "./packages"
