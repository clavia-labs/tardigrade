import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ObjectRef, objectRefOf } from "./reference"

const abcDigest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("object identity", () => {
  test("matches SHA-256 vectors for empty bytes and abc", async () => {
    expect(await Effect.runPromise(objectRefOf(new Uint8Array()))).toEqual({
      algorithm: "sha256",
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    })
    expect(await Effect.runPromise(objectRefOf(new TextEncoder().encode("abc")))).toEqual({
      algorithm: "sha256",
      digest: abcDigest
    })
  })

  test("hashes only the supplied view and leaves its backing bytes unchanged", async () => {
    const bytes = new Uint8Array([0, 97, 98, 99, 255])
    const reference = await Effect.runPromise(objectRefOf(bytes.subarray(1, 4)))
    expect(reference.digest).toBe(abcDigest)
    expect(bytes).toEqual(new Uint8Array([0, 97, 98, 99, 255]))
    expect(Schema.decodeUnknownSync(ObjectRef)(JSON.parse(JSON.stringify(reference)))).toEqual(reference)
  })

  test("rejects unsupported algorithms and noncanonical digests", () => {
    const isReference = Schema.is(ObjectRef)
    expect(isReference({ algorithm: "sha256", digest: abcDigest })).toBe(true)
    expect(isReference({ algorithm: "sha1", digest: abcDigest })).toBe(false)
    for (const digest of ["", "abc123", abcDigest.toUpperCase(), "g".repeat(64), `${abcDigest}0`, `${abcDigest}\n`]) {
      expect(isReference({ algorithm: "sha256", digest })).toBe(false)
    }
  })
})
