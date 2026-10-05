export { LayoutActorDO, LayoutThreadDO } from "./layout-fixture"
export { RetryActorDO, RetryThreadDO } from "./retry-fixture.worker"
import layout from "./layout-fixture"
import { retryFetch } from "./retry-fixture.worker"

export default { fetch: (request: Request, env: Parameters<typeof retryFetch>[1] & Parameters<typeof layout.fetch>[1]) =>
  new URL(request.url).pathname.startsWith("/v1/actors/retry-direct-") ? retryFetch(request, env) : layout.fetch(request, env),
}
import { DurableObject } from "cloudflare:workers"

export class TestPromiseResolver extends DurableObject { alarm(): Promise<void> { return Promise.resolve() } }
