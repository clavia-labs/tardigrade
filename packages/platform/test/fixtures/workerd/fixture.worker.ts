export { LayoutActorDO, LayoutThreadDO } from "./layout-fixture"
export { RetryActorDO, RetryThreadDO } from "./retry-fixture.worker"
export { SlowActorDO, SlowThreadDO } from "./slow-act-fixture.worker"
import layout from "./layout-fixture"
import { retryFetch } from "./retry-fixture.worker"
import { slowFetch } from "./slow-act-fixture.worker"

export default { fetch: (request: Request, env: Parameters<typeof retryFetch>[1] & Parameters<typeof slowFetch>[1] & Parameters<typeof layout.fetch>[1]) => {
  const path = new URL(request.url).pathname
  return path.startsWith("/v1/actors/retry-direct-") ? retryFetch(request, env) : path.startsWith("/v1/actors/watchdog-slow-") ? slowFetch(request, env) : layout.fetch(request, env)
},
}
import { DurableObject } from "cloudflare:workers"

export class TestPromiseResolver extends DurableObject { alarm(): Promise<void> { return Promise.resolve() } }
