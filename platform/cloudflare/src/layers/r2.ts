import { Context, Effect, Layer } from "effect"
import { classifyR2Error, R2StorageError, type R2ErrorClassification, type R2Operation } from "./r2-error"

export interface R2StorageOptions {
  readonly classifyError?: (cause: unknown, operation: R2Operation) => R2ErrorClassification
}

// R2Storage reads and writes byte objects through a supplied bucket binding.
export class R2Storage extends Context.Service<R2Storage, {
  readonly read: (key: string) => Effect.Effect<Uint8Array | undefined, R2StorageError>
  readonly write: (key: string, bytes: Uint8Array) => Effect.Effect<void, R2StorageError>
}>()("tardigrade/cloudflare/R2Storage") {}

export const makeR2Storage = (bucket: Pick<R2Bucket, "get" | "put">, options: R2StorageOptions = {}): typeof R2Storage.Service => {
  const classify = options.classifyError ?? classifyR2Error
  const failure = (operation: R2Operation, cause: unknown) => new R2StorageError({ ...classify(cause, operation), operation, cause })
  return {
    read: (key) => Effect.gen(function* () {
      const object = yield* Effect.tryPromise({
        try: () => bucket.get(key),
        catch: (cause) => failure("get", cause)
      })
      if (object === null) return undefined
      const bytes = yield* Effect.tryPromise({
        try: () => object.arrayBuffer(),
        catch: (cause) => failure("arrayBuffer", cause)
      })
      return new Uint8Array(bytes)
    }),
    write: (key, bytes) => Effect.tryPromise({
      try: () => bucket.put(key, bytes),
      catch: (cause) => failure("put", cause)
    }).pipe(Effect.asVoid)
  }
}

export const layerR2Storage = (bucket: Pick<R2Bucket, "get" | "put">, options: R2StorageOptions = {}): Layer.Layer<R2Storage> =>
  Layer.succeed(R2Storage, makeR2Storage(bucket, options))
