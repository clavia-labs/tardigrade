import type { Component, ViewAlgebra } from "@clavia/tardigrade-core/actor"
import type { Transition } from "@clavia/tardigrade-core/runtime"
import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ToolSpec } from "../model/request"
import type { OutputFallback } from "../output/contract"
import type { ContextPolicy } from "./compact/context"
import type { ToolConcurrency, PendingCall, Answer } from "./tool/machine"

// AgentTool describes a model-visible tool without executable handlers.
export interface AgentTool {
  readonly concurrency?: ToolConcurrency
  readonly spec: ToolSpec
}

// ToolOffer binds a tool description to work proposed by its owner.
export interface ToolOffer<R = never> extends AgentTool {
  readonly serve?: (call: PendingCall, log: ReadonlyArray<Event>, answer: Answer) => ReadonlyArray<Transition<never, R>>
}

export interface ToolInteractions<R = never> {
  readonly tools: () => ReadonlyArray<ToolOffer<R>>
}

// ContextFragment names one component's context policy contribution. contextOf rejects
// conflicting fields, so composition cannot hide a policy override.
export interface ContextFragment {
  readonly component: string
  readonly policy: Partial<ContextPolicy>
}

// NativeOutputFragment selects provider-native structured output without a fallback.
export interface NativeOutputFragment {
  readonly component: string
  readonly kind: "native"
}

// FallbackOutputFragment selects provider-native structured output with a fallback for calls the
// provider cannot serve natively (src/output/contract.ts, OutputFallback).
export interface FallbackOutputFragment {
  readonly component: string
  readonly kind: "fallback"
  readonly fallback: OutputFallback
  // The prompt this fallback needs when it runs. It reaches the model only on an attempt whose
  // mode is this fallback, so a native attempt reads exactly what it would read with nothing
  // mounted (request.ts, OutputRequest; packages/agent/src/model/execution/output.ts).
  readonly system?: string
}

export type OutputFragment = NativeOutputFragment | FallbackOutputFragment

// MessageView supplies conversation messages to inference.
export interface MessageView {
  readonly component: string
  readonly trajectory: ReadonlyArray<Event>
  readonly context: Partial<ContextPolicy>
  readonly checkpoint?: { readonly keepFrom: string; readonly summary: string }
  readonly compaction?: {
    readonly proposals: ReadonlyArray<string>
    readonly triggerRatio: number
  }
  readonly ready: boolean
}

// AgentView is the view the infer root interprets. Arrays retain component order and
// postpone collision policy until the complete component output is available.
export interface AgentView {
  readonly messages?: ReadonlyArray<MessageView>
  readonly system: ReadonlyArray<string>
  readonly tools: ReadonlyArray<AgentTool>
  readonly context: ReadonlyArray<ContextFragment>
  readonly output: ReadonlyArray<OutputFragment>
}

// AgentComponent is a core component whose view is interpreted by its infer root.
export type AgentComponent<R = never, View = AgentView, Result = never, Interactions = unknown> = Component<View, R, Result, Interactions>

// AGENT_VIEW_ALGEBRA preserves every view contribution in component order. renderOf
// applies the agent-specific collision and rendering rules to the combined value.
export const AGENT_VIEW_ALGEBRA: ViewAlgebra<AgentView> = {
  empty: { system: [], tools: [], context: [], output: [] },
  combine: (left, right) => ({
    ...((left.messages === undefined && right.messages === undefined) ? {} : { messages: [...(left.messages ?? []), ...(right.messages ?? [])] }),
    system: [...left.system, ...right.system],
    tools: [...left.tools, ...right.tools],
    context: [...left.context, ...right.context],
    output: [...left.output, ...right.output]
  })
}
