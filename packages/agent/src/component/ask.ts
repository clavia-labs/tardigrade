import { actorCall } from "@clavia/tardigrade-core/interaction/invoke"
import { actorInvocationContextOf } from "@clavia/tardigrade-core/interaction/invocation"
import { calls, composeComponents, inheritComponentContract, component as defineComponent, type ThreadTarget, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import { Router } from "@clavia/tardigrade-core/transport/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { AGENT_VIEW_ALGEBRA, type AgentComponent, type AgentTool } from "../runtime/composition"
import { requestAskMethod } from "../actor/ask"
import { askAnswered, askDenied, askRequested } from "../log/events"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { turnEpochOf } from "@clavia/tardigrade-code/execution/turns"
import { formatThreadAddress, isThreadAddress, type ThreadAddress } from "@clavia/tardigrade-core/transport/endpoint"
import type { Link } from "@clavia/tardigrade-core/transport/link"
import { threadCreatedOf } from "@clavia/tardigrade-core/interaction/relations"
import { outputErrors, outputFrom } from "../output/contract"
import type { ToolSpec } from "../inference/request"

export type AskAuthorityMethods = {
  readonly requestAsk: typeof requestAskMethod
}

export interface CallerAskAuthority {
  readonly kind: "caller"
  readonly methods: AskAuthorityMethods
}

export type AskAuthority = ThreadTarget<AskAuthorityMethods> | CallerAskAuthority

// askCaller selects the actor that invoked the current message call as its ask authority.
export const askCaller = (): CallerAskAuthority => ({
  kind: "caller",
  methods: { requestAsk: requestAskMethod }
})

export interface AskOptions {
  readonly authority?: AskAuthority
  // schema is the answer contract every ask on this assembly must satisfy. The model supplies only a prompt.
  readonly schema?: unknown
  // timeoutMs bounds the authority call. Omitted uses DEFAULT_ACTOR_METHOD_TIMEOUT_MS (packages/core/src/actor/method.ts).
  readonly timeoutMs?: number
}

// ASK_TOOL_NAME is the model-visible tool the ask component mounts.
export const ASK_TOOL_NAME = "ask"

// ASK_SCHEMA_NAME is the output-contract identity used to validate an ask schema (output/contract.ts, OUTPUT_NAME_PATTERN).
export const ASK_SCHEMA_NAME = "ask"

const ASK_SYSTEM =
  "When you need a fact or decision only a human can provide, call ask with a prompt and a JSON Schema for the answer. The turn waits until they reply. The schema must be a closed object: every property is required and additionalProperties is false."

const ASK_SYSTEM_MOUNTED =
  "When you need a fact or decision only a human can provide, call ask with a prompt. The answer must match the schema this assembly mounted. The turn waits until they reply."

const ASK_TOOL_PROPERTIES = {
  prompt: { type: "string", description: "The question to ask the human." },
  schema: {
    type: "object",
    description: "JSON Schema for the expected answer. A closed object: every property required, additionalProperties false."
  }
} as const

const askToolSpec = (mounted: boolean): ToolSpec => ({
  name: ASK_TOOL_NAME,
  description: mounted
    ? "Ask a human a question and wait for a structured answer. The turn parks until they reply."
    : "Ask a human a question and wait for a structured answer. The turn parks until they reply. Pass a closed object JSON Schema for the answer.",
  inputSchema: mounted
    ? {
        type: "object",
        properties: { prompt: ASK_TOOL_PROPERTIES.prompt },
        required: ["prompt"],
        additionalProperties: false
      }
    : {
        type: "object",
        properties: ASK_TOOL_PROPERTIES,
        required: ["prompt", "schema"],
        additionalProperties: false
      }
})

const field = (event: Event, name: string): string => String((event as Record<string, unknown>)[name] ?? "")

const schemaContract = (schema: unknown) => outputFrom(ASK_SCHEMA_NAME, schema)

const schemaErrors = (schema: unknown): ReadonlyArray<string> => {
  const built = schemaContract(schema)
  return "errors" in built ? built.errors : []
}

const answerErrors = (schema: unknown, value: unknown): ReadonlyArray<string> => {
  const built = schemaContract(schema)
  return "errors" in built ? built.errors : outputErrors(schema, value)
}

const askCallId = (child: ThreadAddress, turn: string, request: string): string =>
  `ask/${formatThreadAddress(child)}/${turn}/${request}`

const authorityFor = (
  log: ReadonlyArray<Event>,
  turn: string,
  authority: AskAuthority | undefined
): ThreadTarget<AskAuthorityMethods> | undefined => {
  if (authority === undefined) return undefined
  if ("coordinate" in authority || "address" in authority) return authority
  const head = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, ThreadAddress> } | undefined
  return isThreadAddress(head?.link?.source)
    ? { coordinate: head.link.source, methods: { requestAsk: requestAskMethod } }
    : undefined
}

const sourceFor = (log: ReadonlyArray<Event>, turn: string): ThreadAddress | undefined => {
  const head = log.find((event) =>
    event.type === "MessageReceived" && String((event as { readonly id?: unknown }).id) === turn
  ) as { readonly link?: Link<unknown, unknown> } | undefined
  if (isThreadAddress(head?.link?.target)) return head.link.target
  return threadCreatedOf(log)?.address
}

const askTool = (options: AskOptions, mountedSchema: unknown | undefined): AgentTool<Router | Self> => ({
  spec: askToolSpec(mountedSchema !== undefined),
  serve: (call, log, answer) => {
    const stamp = call.turn === undefined ? {} : { turn: call.turn }
    const invocation = call.turn === undefined
      ? {}
      : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } }
    const requested = log.find((event) =>
      event.type === "AskRequested" && field(event, "callId") === call.callId && (event.turn ?? "") === (call.turn ?? "")
    )
    if (requested === undefined) {
      const args = call.arguments as { prompt?: unknown; schema?: unknown } | undefined
      const prompt = args?.prompt
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return [answer({ error: `ask takes prompt as a nonempty string; got ${JSON.stringify(prompt)}` })]
      }
      const schema = mountedSchema ?? args?.schema
      const errors = schemaErrors(schema)
      if (errors.length > 0) {
        return [answer({ error: `ask schema is not declarable:\n${errors.map((error) => `- ${error}`).join("\n")}` })]
      }
      const built = schemaContract(schema)
      const recorded = "errors" in built ? schema : built.contract.schema
      return [
        call.context.intent("ask.request", (at) => askRequested({
          callId: call.callId, prompt, schema: recorded, ...stamp, at
        }), invocation)
      ]
    }
    const decision = log.find((event) =>
      (event.type === "AskAnswered" || event.type === "AskDenied") &&
      field(event, "callId") === call.callId &&
      (call.turn === undefined || field(event, "turn") === "" || field(event, "turn") === call.turn)
    )
    if (decision !== undefined) {
      if (decision.type === "AskDenied") {
        const reason = field(decision, "reason")
        return [answer({
          denied: true,
          ...(reason === "" ? {} : { reason })
        })]
      }
      const schema = (requested as { readonly schema?: unknown }).schema
      const value = (decision as { readonly answer?: unknown }).answer
      const errors = answerErrors(schema, value)
      if (errors.length > 0) {
        return [answer({ error: `ask answer misses the schema:\n${errors.map((error) => `- ${error}`).join("\n")}` })]
      }
      return [answer({ answered: value })]
    }
    const target = authorityFor(log, call.turn ?? "", options.authority)
    const source = sourceFor(log, call.turn ?? "")
    if (target === undefined || source === undefined) return []
    const turn = call.turn ?? ""
    const callId = askCallId(source, turn, call.callId)
    const message = { method: "message", id: turn, epoch: call.epoch ?? (turn === "" ? 0 : turnEpochOf(log, turn)) }
    const actor = actorCall(log, {
      id: callId,
      target,
      method: "requestAsk",
      ...(turn === "" ? {} : {
        context: actorInvocationContextOf(log, message) ?? { invocation: message }
      }),
      input: {
        request: call.callId,
        turn,
        prompt: String((requested as { readonly prompt?: unknown }).prompt ?? ""),
        schema: (requested as { readonly schema?: unknown }).schema
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
    }, { context: call.context, tag: "ask" })
    if (actor.transitions.length > 0) return actor.transitions
    if (actor.state.status === "pending") return []
    if (actor.state.status === "failed") {
      const error = actor.state.error
      return [call.context.intent("ask.decide", (at) => askDenied({
        callId: call.callId, reason: `Ask authority failed: ${error}`, ...stamp, at
      }), invocation)]
    }
    if (actor.state.status === "cancelled") {
      const cancelled = actor.state.reason ?? actor.state.cause
      return [call.context.intent("ask.decide", (at) => askDenied({
        callId: call.callId,
        reason: `Ask authority cancelled: ${cancelled}`,
        ...stamp,
        at
      }), invocation)]
    }
    if (actor.state.status !== "completed") return []
    const output = actor.state.output
    if ("denied" in output) {
      return [call.context.intent("ask.decide", (at) => askDenied({
        callId: call.callId,
        ...(typeof output.reason === "string" && output.reason !== "" ? { reason: output.reason } : {}),
        ...stamp,
        at
      }), invocation)]
    }
    return [call.context.intent("ask.decide", (at) => askAnswered({
      callId: call.callId, answer: output.answered, ...stamp, at
    }), invocation)]
  }
})

// ask mounts a schema-shaped human question tool. An unanswered ask parks the turn (component/ask.test.ts).
export const ask = <
  const Cs extends ReadonlyArray<AgentComponent<never> | AgentComponent<unknown>>
>(
  components: Cs,
  options: AskOptions = {}
): AgentComponent<ComponentRequirements<Cs[number]> | Router | Self> => {
  type R = ComponentRequirements<Cs[number]>
  const mounted = options.schema === undefined ? undefined : (() => {
    const built = schemaContract(options.schema)
    if ("errors" in built) {
      throw new Error(`ask schema is not declarable:\n${built.errors.map((error) => `- ${error}`).join("\n")}`)
    }
    return built.contract.schema
  })()
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    throw new Error(`ask timeoutMs must be a positive safe integer, got ${JSON.stringify(options.timeoutMs)}`)
  }
  const combined = composeComponents("ask.children", AGENT_VIEW_ALGEBRA, components) as AgentComponent<R>
  const machine = combined.machine
  const tool = askTool(options, mounted)
  const system = mounted === undefined ? ASK_SYSTEM : ASK_SYSTEM_MOUNTED
  const project = (children: ReturnType<typeof machine.output>) => ({
    view: {
      ...children.view,
      system: [...children.view.system, system],
      tools: [...children.view.tools, tool]
    },
    transitions: children.transitions
  })
  const common = {
    name: "ask",
    children: [combined]
  }
  const component: AgentComponent<R | Router | Self> = defineComponent({
    ...common,
    initial: machine.initial,
    step: machine.step,
    cancelState: (state, cancellation) => machine.cancel?.(state, cancellation) ?? [],
    output: (state) => project(machine.output(state))
  })
  const inherited = inheritComponentContract(component, combined)
  return options.authority === undefined
    ? inherited
    : calls(options.authority, requestAskMethod, inherited)
}
