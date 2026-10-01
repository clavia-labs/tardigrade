import { agentMethods } from "@clavia/tardigrade-experimental-agent/actor/methods"
import { atom, defineActor, effectAtom, eventValue, type ActService } from "@clavia/tardigrade-experimental-core"
import { compact, infer, systemPrompt, conversation, permissions, pendingTools, codeMode } from "@clavia/tardigrade-experimental-agent/atoms"
import { Effect } from "effect"
import { Event } from "@clavia/tardigrade-experimental-agent/contracts/code-mode"

export const actor = defineActor("tardie", Effect.gen(function* () {
  const available = yield* codeMode({ name: "agent.code-mode" })
  const permission = permissions(pendingTools, { tools: available })
  const tools = effectAtom(get => {
    const inner = get(available)
    const approval = get(permission)
    const queue = get(pendingTools)
    const call = queue.pending
    const decision = approval.view.decisions.findLast(value => value.action === "tool.execute" && value.requestId === call?.callId)?.decision
    if (!call || decision?.allowed) return {
      ...inner, events: { ...inner.events, ...approval.events }, acts: { ...inner.acts, ...approval.acts },
    }
    return {
      view: inner.view, acts: approval.acts,
      events: { ...approval.events, ...(decision ? queue.running
        ? { returned: eventValue({ type: "ToolReturned", callId: call.callId, output: "", error: decision.reason } as const) }
        : { called: eventValue({ type: "ToolCalled", callId: call.callId, counted: false } as const) } : {}) },
    }
  })
  const system = systemPrompt("You are a helpful assistant. Use execute to run JavaScript against the connected packages. Keep answers concise and practical.")
  const context = yield* compact(conversation)
  const agent = yield* infer<ActService<"code-mode.evaluate"> | ActService<"code-mode.package"> | ActService<"agent.permission.request">, typeof Event.Type>(atom(get => ({ system: get(system), tools: get(tools), context: get(context) })))
  return { atom: agent, methods: agentMethods }
}))
