import { Context, Effect, Layer } from "effect"
import { classifyWorkerLoaderError, WorkerLoaderError, type WorkerLoaderErrorClassification, type WorkerLoaderStage } from "./worker-loader-error"

export interface DynamicWorkerLoaderOptions {
  readonly classifyError?: (cause: unknown, stage: WorkerLoaderStage, operation: string) => WorkerLoaderErrorClassification
}

// DynamicWorkerLoader exposes worker loading, calls and optional disposal as typed effects.
export class DynamicWorkerLoader extends Context.Service<DynamicWorkerLoader, {
  readonly load: (code: WorkerLoaderWorkerCode) => Effect.Effect<WorkerStub, WorkerLoaderError>
  readonly call: <A>(worker: WorkerStub, operation: string, invoke: (worker: WorkerStub) => PromiseLike<A>) => Effect.Effect<A, WorkerLoaderError>
  readonly dispose: (worker: WorkerStub) => Effect.Effect<"disposed" | "unsupported", WorkerLoaderError>
}>()("tardigrade/cloudflare/DynamicWorkerLoader") {}

export const layerDynamicWorkerLoader = (
  loader: Pick<WorkerLoader, "load">,
  options: DynamicWorkerLoaderOptions = {}
): Layer.Layer<DynamicWorkerLoader> => {
  const classify = options.classifyError ?? classifyWorkerLoaderError
  const failure = (stage: WorkerLoaderStage, operation: string, cause: unknown) =>
    new WorkerLoaderError({ ...classify(cause, stage, operation), stage, operation, cause })
  return Layer.succeed(DynamicWorkerLoader, {
    load: (code) => Effect.try({
      try: () => loader.load(code),
      catch: (cause) => failure("load", "load", cause)
    }),
    call: (worker, operation, invoke) => Effect.tryPromise({
      try: () => Promise.resolve(invoke(worker)),
      catch: (cause) => failure("call", operation, cause)
    }),
    dispose: (worker) => Effect.tryPromise({
      try: async () => {
        const extensions = worker as WorkerStub & Partial<Record<PropertyKey, unknown>>
        const symbols = Symbol as { readonly asyncDispose?: symbol; readonly dispose?: symbol }
        let release = extensions["dispose"]
        if (typeof release !== "function" && symbols.asyncDispose !== undefined) release = extensions[symbols.asyncDispose]
        if (typeof release !== "function" && symbols.dispose !== undefined) release = extensions[symbols.dispose]
        if (typeof release !== "function") return "unsupported" as const
        await release.call(worker)
        return "disposed" as const
      },
      catch: (cause) => failure("dispose", "dispose", cause)
    })
  })
}
