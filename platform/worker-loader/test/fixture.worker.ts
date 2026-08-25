import { DurableObject } from "cloudflare:workers"
import type { SandboxBridgeCall } from "../src/sandbox"
import type { SandboxCallOutcome } from "@clavia/tardigrade-code/sandbox/service"

export interface Env {
  readonly BRIDGE: DurableObjectNamespace<SandboxBridge>
  readonly LOADER: WorkerLoader
}

export class SandboxBridge extends DurableObject<Env> {
  async sandboxCallBatch(
    _execution: string,
    _calls: ReadonlyArray<SandboxBridgeCall>
  ): Promise<ReadonlyArray<SandboxCallOutcome>> {
    throw new Error("the runtime suite does not route capability calls")
  }
}

export default { fetch: () => new Response("worker loader test") } satisfies ExportedHandler<Env>
