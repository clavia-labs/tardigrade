import { DurableObject } from "cloudflare:workers"
import { Effect, Layer, Schema } from "effect"
import { atom, defineActor, durableAtom } from "@clavia/tardigrade-experimental-core"
import { createCloudflareHost, cloudflareHandler } from "@clavia/tardigrade-experimental-platform/cloudflare"

const Message = Schema.Struct({ type: Schema.Literal("MessageReceived"), text: Schema.String })
const messages = durableAtom({
  input: Message,
  schema: Schema.Array(Schema.String),
  initial: [],
  reduce: (state, event: typeof Message.Type) => [...state, event.text],
})
const actor = defineActor("inbox", Effect.succeed({
  atom: Object.assign(atom(get => ({ messages: get(messages) })), { schema: Message }),
  actions: { message: (input: { text: string }): typeof Message.Type => ({ type: "MessageReceived", text: input.text }) },
}))

interface Env { readonly ACTORS: DurableObjectNamespace<ActorDO> }

export class ActorDO extends DurableObject<Env> {
  private readonly host = createCloudflareHost({
    actor,
    storage: this.ctx.storage,
    layersFor: () => Layer.empty,
  })
  private readonly http = cloudflareHandler(this.host)

  async fetch(request: Request): Promise<Response> {
    return this.http.handler(request)
  }

  async state(instance: string, thread: string) {
    return (await this.host.getThread({ instance, thread }))?.getState()
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const instance = /^\/v1\/actors\/([^/]+)\/threads(?:\/|$)/.exec(new URL(request.url).pathname)?.[1]
    if (!instance) return new Response("Not found", { status: 404 })
    return env.ACTORS.getByName(decodeURIComponent(instance)).fetch(request)
  },
}
