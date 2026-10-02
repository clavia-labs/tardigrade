/// <reference types="@cloudflare/workers-types" />

import { Context, Effect } from "effect"

import { DurableObject } from "cloudflare:workers"
import { Layer } from "effect"
import { createCloudflareHost, cloudflareHandler } from "@clavia/tardigrade-platform/cloudflare"

import { actor } from "./agents/inbox"

interface Env { readonly ACTORS: DurableObjectNamespace<ActorDO> }

export class ActorDO extends DurableObject<Env> {
  private readonly host = createCloudflareHost({
    actor,
    storage: this.ctx.storage,
    actorContext: () => Context.empty(),
    services: () => Layer.empty,
  })
  private readonly http = cloudflareHandler(this.host)

  async fetch(request: Request): Promise<Response> {
    return this.http.handler(request)
  }

  async state(instance: string, thread: string) {
    return (await Effect.runPromise(this.host.getThread({ instance, thread })))?.getState()
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const instance = /^\/v1\/actors\/([^/]+)\/threads(?:\/|$)/.exec(new URL(request.url).pathname)?.[1]
    if (!instance) return new Response("Not found", { status: 404 })
    return env.ACTORS.getByName(decodeURIComponent(instance)).fetch(request)
  },
}
