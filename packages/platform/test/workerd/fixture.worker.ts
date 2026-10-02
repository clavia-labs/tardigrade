import { DurableObject } from "cloudflare:workers"

export class TestPromiseResolver extends DurableObject { alarm(): Promise<void> { return Promise.resolve() } }
export default { fetch: () => new Response("experimental runtime tests") }
