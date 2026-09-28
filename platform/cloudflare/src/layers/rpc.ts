import { Context, Effect, Layer } from "effect"
import { classifyDurableObjectRpcError, DurableObjectRpcError, type DurableObjectRpcErrorClassification, type DurableObjectRpcStage } from "./rpc-error"

export interface DurableObjectRpcOptions {
  readonly classifyError?: (cause: unknown, stage: DurableObjectRpcStage, operation: string) => DurableObjectRpcErrorClassification
}

// DurableObjectRpc retains the stub's method types while capturing lookup and RPC failures.
export class DurableObjectRpc extends Context.Service<DurableObjectRpc, {
  readonly call: <Stub, A>(
    namespace: { readonly getByName: (name: string) => Stub },
    name: string,
    operation: string,
    invoke: (stub: Stub) => PromiseLike<A>
  ) => Effect.Effect<A, DurableObjectRpcError>
}>()("tardigrade/cloudflare/DurableObjectRpc") {}

// makeDurableObjectRpc acquires a fresh stub for every call and records whether a failed call had acquired one.
export const makeDurableObjectRpc = (options: DurableObjectRpcOptions = {}): typeof DurableObjectRpc.Service => {
  const classify = options.classifyError ?? classifyDurableObjectRpcError
  return {
    call: (namespace, name, operation, invoke) => Effect.suspend(() => {
      let stage: DurableObjectRpcStage = "lookup"
      return Effect.tryPromise({
        try: () => {
          const stub = namespace.getByName(name)
          stage = "call"
          return Promise.resolve(invoke(stub))
        },
        catch: (cause) => new DurableObjectRpcError({
          ...classify(cause, stage, operation), stage, operation, cause, stubRecreationRequired: stage === "call"
        })
      })
    })
  }
}

export const layerDurableObjectRpcWith = (options: DurableObjectRpcOptions = {}): Layer.Layer<DurableObjectRpc> =>
  Layer.succeed(DurableObjectRpc, makeDurableObjectRpc(options))

export const layerDurableObjectRpc: Layer.Layer<DurableObjectRpc> = layerDurableObjectRpcWith()
