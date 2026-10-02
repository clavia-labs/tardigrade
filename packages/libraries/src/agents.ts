import { Effect, Schema } from "effect"
import { Rpc } from "effect/unstable/rpc"
import { Actor, ExecutionHandle, RuntimeError } from "@clavia/tardigrade-core"
import { defineLibrary, MethodDescription, MethodHints, MethodExecution } from "./library"

export const DEFAULT_AGENT_ACTOR = "tardie"
export const DEFAULT_AGENT_TOOL_CALLS = 20
export const AgentBudget = Schema.Struct({ toolCalls: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)) })
export const AgentMessage = Schema.Struct({ text: Schema.String, budget: Schema.optionalKey(AgentBudget) })

// agents submits child calls through the core actor service and returns durable handles.
export function agents(options: { readonly actor?: string; readonly budget?: { readonly toolCalls?: number } } = {}) {
  const budget = { toolCalls: options.budget?.toolCalls ?? DEFAULT_AGENT_TOOL_CALLS }
  if (!Schema.is(AgentBudget)(budget)) throw new RuntimeError("Child toolCalls must be a nonnegative safe integer")
  const library = defineLibrary({
    toolNames: { run: "delegate_task", cancel: "cancel_agent" },
    name: "agents", description: "Delegate work to child agents.",
    methods: [
      Rpc.make("run", { payload: Schema.Struct({ message: Schema.String }), success: ExecutionHandle, error: Schema.String })
        .annotate(MethodDescription, `Start a child agent with a message and at most ${budget.toolCalls} tool calls per turn. Model spend is uncapped. Returns a durable handle immediately; its result arrives in the inbox.`)
        .annotate(MethodHints, { readOnlyHint: false, openWorldHint: true })
        .annotate(MethodExecution, "background"),
      Rpc.make("cancel", { payload: Schema.Struct({ handle: ExecutionHandle }),
        success: Schema.Struct({ handle: ExecutionHandle, cancellationRequested: Schema.Boolean }), error: Schema.String,
      }).annotate(MethodDescription, "Cancel a child using its execution handle. Its promise will settle with cancellation if still pending.")
        .annotate(MethodHints, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }),
    ],
  })
  return library.implement({
    run: ({ message }, { requestId }) => Actor.use(actor => actor.invoke({ id: String(requestId),
      target: { actor: options.actor ?? DEFAULT_AGENT_ACTOR, instance: String(requestId), thread: String(requestId) },
      method: "message", input: { text: message, budget },
    })).pipe(Effect.mapError(String)),
    cancel: ({ handle }) => Effect.gen(function* () {
      yield* (yield* Actor).cancel(handle)
      return { handle, cancellationRequested: true }
    }).pipe(Effect.mapError(String)),
  }, { submit: ["run"], cancel: { run: (handle, call) => Actor.use(actor => actor.cancel(handle ?? { executor: "actor", id: call.callId })) } })
}
