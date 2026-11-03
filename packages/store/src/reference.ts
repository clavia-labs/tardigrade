import { Effect, Schema } from "effect"

// ObjectRef identifies raw bytes by their SHA-256 digest (reference.test.ts).
export const ObjectRef = Schema.Struct({
  algorithm: Schema.Literal("sha256"),
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
})

export type ObjectRef = typeof ObjectRef.Type

// objectRefOf hashes the supplied byte view without attachment metadata (reference.test.ts).
export const objectRefOf = (bytes: Uint8Array): Effect.Effect<ObjectRef> =>
  Effect.promise(async () => {
    const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
    const digest = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return { algorithm: "sha256", digest }
  })

// objectKeyOf includes the algorithm in the storage identity (key-value.test.ts).
export const objectKeyOf = (reference: ObjectRef): string => `${reference.algorithm}:${reference.digest}`
