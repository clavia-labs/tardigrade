import { Context, Effect, Layer, Schema } from "effect"
import { actor, actorMethod } from "tardie"
import { effect } from "@clavia/tardigrade-core/reconciliation"
import {
  ActorHost,
  cloudflareWorker,
  type CloudflareWorkerLayerContext,
  type Env
} from "../src/worker"

interface FixtureEnv extends Env {
  readonly APPLICATION_PREFIX: string
}

class LaneApplication extends Context.Service<
  LaneApplication,
  { readonly prefix: string; readonly lane: string; calls: number }
>()("test/LaneApplication") {}

const echo = actorMethod({
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  event: ({ id, input, at }) => ({ type: "EchoRequested", id, text: input.text, at }),
  state: (events, id) => {
    const event = events.find((candidate) =>
      candidate.type === "EchoCompleted" && (candidate as { readonly id?: unknown }).id === id
    ) as { readonly text?: unknown } | undefined
    if (event !== undefined) return { status: "completed" as const, output: String(event.text) }
    return events.some((candidate) =>
      candidate.type === "EchoRequested" && (candidate as { readonly id?: unknown }).id === id
    ) ? { status: "pending" as const } : undefined
  }
})

const worker = cloudflareWorker(actor({
  name: "echo",
  methods: { echo },
  components: [{
    name: "echo",
    keys: {
      prefixes: ["echo-request:", "echo-complete:"],
      keyOf: (event) => {
        const id = String((event as { readonly id?: unknown }).id)
        if (event.type === "EchoRequested") return `echo-request:${id}`
        if (event.type === "EchoCompleted") return `echo-complete:${id}`
        return undefined
      }
    },
    derive: (events) => ({ view: undefined, transitions: events.flatMap((event) => {
      if (event.type !== "EchoRequested") return []
      const request = event as { readonly id?: unknown; readonly text?: unknown }
      const id = String(request.id)
      if (events.some((candidate) =>
        candidate.type === "EchoCompleted" && (candidate as { readonly id?: unknown }).id === id
      )) return []
      return [effect({
        key: `echo-complete:${id}`,
        input: { id, text: String(request.text) },
        act: (input) => Effect.gen(function* () {
          const application = yield* LaneApplication
          application.calls += 1
          yield* Effect.promise(() => scheduler.wait(50))
          return [{ type: "EchoCompleted", ...input, text: `${application.prefix}:${application.lane}:${application.calls}:${input.text}` }]
        })
      })]
    }) })
  }]
}), {
  placement: "thread",
  layersFor: ({ env, lane }: CloudflareWorkerLayerContext<FixtureEnv>) =>
    Layer.succeed(LaneApplication, { prefix: env.APPLICATION_PREFIX, lane, calls: 0 })
})

export { ActorHost }
export default worker
