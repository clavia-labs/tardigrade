import { bunSandboxServiceFor, type BunSandboxPolicy } from "@clavia/tardigrade-bun/sandbox"
import { sandboxIsolate } from "../shared/isolate"

export { DEFAULT_BUN_SANDBOX_POLICY as DEFAULT_ISOLATE_POLICY } from "@clavia/tardigrade-bun/sandbox"
export type IsolatePolicy = BunSandboxPolicy

// bunIsolate runs each code body in a Bun subprocess and routes package calls through its scoped RPC handler.
export function bunIsolate(policy: Partial<IsolatePolicy> = {}) {
  return sandboxIsolate(bunSandboxServiceFor(policy))
}
