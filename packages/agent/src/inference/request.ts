import type { Event } from "@clavia/tardigrade-core/log/event"
import type { ContextPolicy } from "../component/compaction"
import { renderMessages, type AgentMessage } from "../projection/messages"
import {
  declaredOutputOf,
  type OutputContract,
  type OutputFallback
} from "../output/contract"

// The model request, decided from the trajectory: system prompt, tool surface, message
// projection. Domain policy lives with the agent; the platform maps these provider-agnostic
// types to one provider's wire, so prompting is testable without a provider and one policy
// serves every provider.

export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

// OutputRequest is the turn's declared final response: the contract, and the implementation that
// must obtain it. It rides the request as itself rather than as a tool, so a binding maps it onto
// the provider's own response-format surface (platform/model/src/output/contract.ts, outputSchemaFor).
//
// `invalid` is the turn that declared an output no contract can be built from. It is on the
// request rather than absent from it, because a request with no output reads as a turn that
// wanted prose, and this one wanted something nobody can serve (output.ts, DeclaredOutput).
export type OutputRequest =
  | {
      readonly kind: "contract"
      readonly contract: OutputContract
      // What the turn does when native structured output is unavailable for this call, and the
      // prompt that fallback needs. Absent means the assembly selected native output, so a call
      // the provider cannot serve fails before it spends. The binding decides which strategy the
      // attempt runs as, and the fallback's prompt reaches the model only then
      // (platform/model/src/output/contract.ts, outputModeOf).
      readonly fallback?: OutputFallback
      readonly fallbackSystem?: string
    }
  | {
      readonly kind: "invalid"
      readonly errors: ReadonlyArray<string>
      readonly fallback?: OutputFallback
    }

export interface ModelRequest {
  readonly system: string
  readonly messages: ReadonlyArray<AgentMessage>
  readonly tools: ReadonlyArray<ToolSpec>
  // Present when the turn declared a contract. Absent turns end in prose.
  readonly output?: OutputRequest
}

// SYSTEM frames the turn around whatever surface is in play: the surface states how the model
// acts, and the frame states how a turn ends. The two are separate so a surface swap rewrites
// only its own half. The frame says nothing about the shape of the answer: a turn that declares
// an output contract gets that shape from the provider's own response format, and a framework
// sentence about it would be one more instruction to disagree with the schema
// (request.test.ts, "the frame never mentions the contract, declared or not").
const SYSTEM = (surface: string): string =>
  `You are an agent. ${surface}\nWhen the work is done, reply directly: that reply is your final answer and ends the turn. Reply without calling a tool when no action is needed.`

// modelRequest folds output and context policy over the component-derived surface. A declared output
// contract adds no tool, tool choice, or prompt sentence because the binding uses the provider's format
// (request.test.ts, "a contract is never a tool, a tool choice, or a sentence in the prompt").
//
// `context` sets what the render truncates. It rides the same rule the surface does: the actor's
// compaction reactor must hold the same policy, so the caller that states one here states it
// there too (compaction.ts, ContextPolicy).
export const modelRequest = (
  trajectory: ReadonlyArray<Event>,
  render: {
    readonly system: string
    readonly tools: ReadonlyArray<ToolSpec>
    readonly output?: { readonly fallback: OutputFallback; readonly system?: string }
  },
  context: Partial<ContextPolicy> = {}
): ModelRequest => {
  const declared = declaredOutputOf(trajectory)
  const fallback = render.output
  const base = SYSTEM(render.system)
  return {
    system: base,
    messages: renderMessages(trajectory, context),
    tools: render.tools,
    ...(declared.kind === "none"
      ? {}
      : {
          output:
            declared.kind === "contract"
              ? ({
                  kind: "contract",
                  contract: declared.contract,
                  ...(fallback === undefined ? {} : { fallback: fallback.fallback }),
                  ...(fallback?.system === undefined ? {} : { fallbackSystem: fallback.system })
                } as const)
              : ({
                  kind: "invalid",
                  errors: declared.errors,
                  ...(fallback === undefined ? {} : { fallback: fallback.fallback })
                } as const)
        })
  }
}
