import { Effect, Schema } from "effect"
import { ExecutionHandle } from "@clavia/tardigrade-experimental-core"
import { Actor } from "@clavia/tardigrade-experimental-host"
import { definePackage } from "./package"
import { promiseTool, tool } from "./tool"

// agents submits child calls through the host actor service and returns promise handles.
export function agents() {
  return definePackage({
    name: "agents", description: "Delegate work to child agents.",
    methods: [promiseTool({
      name: "run", description: "Start a child agent with a message. Returns a promise handle immediately; its result arrives in the inbox.",
      input: Schema.Struct({ message: Schema.String }),
      submit: ({ message }, call) => Effect.gen(function* () {
        const actor = yield* Actor
        return yield* actor.submit({ id: call.callId, message })
      }),
    }), tool({
      name: "cancel", description: "Cancel a child using the handle returned by agents.run. Its promise will settle with cancellation if still pending.",
      input: Schema.Struct({ handle: ExecutionHandle }),
      run: ({ handle }) => Effect.gen(function* () {
        yield* (yield* Actor).cancel(handle)
        return { handle, cancellationRequested: true }
      }),
    })],
  })
}
