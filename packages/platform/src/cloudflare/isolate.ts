import { workerLoaderSandboxServiceFor, type WorkerLoaderSandboxPolicy } from "@clavia/tardigrade-worker-loader/sandbox"
import { sandboxIsolate } from "../shared/isolate"

export { DEFAULT_WORKER_LOADER_SANDBOX_POLICY as DEFAULT_WORKER_LOADER_ISOLATE_POLICY } from "@clavia/tardigrade-worker-loader/sandbox"
export type WorkerLoaderIsolatePolicy = WorkerLoaderSandboxPolicy

// workerLoaderIsolate runs each code body in a Worker Loader isolate and routes package calls through its scoped RPC handler.
export function workerLoaderIsolate(loader: WorkerLoader, policy: Partial<WorkerLoaderIsolatePolicy> = {}) {
  return sandboxIsolate(workerLoaderSandboxServiceFor(loader, policy))
}
