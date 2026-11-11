import type { ActorMethods } from "@clavia/tardigrade-core"
import { DEFAULT_METHOD_HTTP_INSTANCE } from "../shared/method-http"
import { createActorObjects, type ActorObjectOptions, type CloudflareObjectBindings } from "./objects"

// createActorWorker routes instance requests to a directory DO and exports its thread DO class (test/workerd/thread-layout.workers.ts).
export function createActorWorker<Env extends object = Record<string, unknown>, Event extends object = object, Services = never, State = unknown, Contracts extends ActorMethods<Event> = ActorMethods<Event>>(options: ActorObjectOptions<Env, Event, Services, State, Contracts>) {
  const objects = createActorObjects(options)
  return {
    ...objects,
    fetch(request: Request, env: Env & CloudflareObjectBindings) {
      const instance = /^\/v1\/actors\/([^/]+)\/threads(?:\/|$)/.exec(new URL(request.url).pathname)?.[1]
      return env.ACTORS.getByName(instance === undefined ? options.http?.(env).instance ?? DEFAULT_METHOD_HTTP_INSTANCE : decodeURIComponent(instance)).fetch(request)
    },
  }
}
