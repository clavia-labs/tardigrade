export { LayoutActorDO, LayoutThreadDO, default } from "./layout-fixture"
import { DurableObject } from "cloudflare:workers"

export class TestPromiseResolver extends DurableObject { alarm(): Promise<void> { return Promise.resolve() } }
