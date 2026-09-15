import { Effect, Layer } from "effect"
import { makeObjectStorage, ObjectStorage } from "@clavia/tardigrade-agent"

export const DEFAULT_R2_OBJECT_PREFIX = "objects/"

// objectStorageFromR2 shares content-addressed objects within the supplied bucket and prefix (test/objects.workers.ts).
export const objectStorageFromR2 = (
  bucket: Pick<R2Bucket, "get" | "put">,
  options: { readonly prefix?: string } = {}
): Layer.Layer<ObjectStorage> => {
  const prefix = options.prefix ?? DEFAULT_R2_OBJECT_PREFIX
  return Layer.succeed(ObjectStorage, makeObjectStorage({
    read: (key) => Effect.tryPromise(async () => {
      const object = await bucket.get(prefix + key)
      return object === null ? undefined : new Uint8Array(await object.arrayBuffer())
    }),
    write: (key, bytes) => Effect.tryPromise(async () => {
      await bucket.put(prefix + key, bytes)
    })
  }))
}
