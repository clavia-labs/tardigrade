import { Effect, Schema } from "effect"
import { ExecutionHandle, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { Actor } from "@clavia/tardigrade-experimental-host"
import { definePackage } from "./package"
import { promiseTool, tool } from "./tool"

export const DEFAULT_AGENT_TOOL_CALLS = 20
export const AgentBudget = Schema.Struct({ toolCalls: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) })

// agents submits child calls through the host actor service and returns promise handles.
export function agents(options: { readonly budget?: { readonly toolCalls?: number } } = {}) {
  const budget = { toolCalls: options.budget?.toolCalls ?? DEFAULT_AGENT_TOOL_CALLS }
  if (!Schema.is(AgentBudget)(budget)) throw new RuntimeError("Child toolCalls must be a nonnegative safe integer")
  return definePackage({
    toolNames: { run: "delegate_task", cancel: "cancel_agent" },
    name: "agents", description: "Delegate work to child agents.",
    methods: [promiseTool({
      name: "run", description: `Start a child agent with a message and at most ${budget.toolCalls} tool calls per turn. Model spend is uncapped. Returns a promise handle immediately; its result arrives in the inbox.`,
      input: Schema.Struct({ message: Schema.String }),
      submit: ({ message }, call) => Effect.gen(function* () {
        const actor = yield* Actor
        return yield* actor.submit({ id: call.callId, message, config: { budget } })
      }),
    }), tool({
      name: "cancel", description: "Cancel a child using its execution handle. Its promise will settle with cancellation if still pending.",
      input: Schema.Struct({ handle: ExecutionHandle }),
      run: ({ handle }) => Effect.gen(function* () {
        yield* (yield* Actor).cancel(handle)
        return { handle, cancellationRequested: true }
      }),
    })],
  })
}
