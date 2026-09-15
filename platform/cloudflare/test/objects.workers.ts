import { env } from "cloudflare:test"
import { expect, test } from "vitest"
import { Effect } from "effect"
import { ObjectStorage } from "@clavia/tardigrade-agent"
import { objectStorageFromR2 } from "../src/object-storage/r2"

const bucket = env.OBJECTS as R2Bucket
const open = (prefix: string) => Effect.runPromise(ObjectStorage.pipe(Effect.provide(objectStorageFromR2(bucket, { prefix }))))

test("R2-backed storage shares objects across service instances while isolating prefixes", async () => {
  const upload = await open("tenant-a/")
  const inference = await open("tenant-a/")
  const isolated = await open("tenant-b/")
  const bytes = new TextEncoder().encode("abc")
  const reference = await Effect.runPromise(upload.put(bytes))
  expect(await Effect.runPromise(inference.put(bytes))).toEqual(reference)
  expect((await bucket.list({ prefix: "tenant-a/" })).objects.map(object => object.key)).toEqual([
    "tenant-a/sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  ])
  expect(await Effect.runPromise(inference.get(reference))).toEqual(bytes)
  expect(await Effect.runPromise(isolated.get(reference).pipe(Effect.flip))).toMatchObject({ reason: "Missing" })
  expect(await Effect.runPromise(isolated.put(bytes))).toEqual(reference)
  await bucket.delete(`tenant-a/${reference.algorithm}:${reference.digest}`)
  expect(await Effect.runPromise(isolated.get(reference))).toEqual(bytes)
})

test("R2 reads reject bytes overwritten outside the content-addressed adapter", async () => {
  const storage = await open("corrupt/")
  const reference = await Effect.runPromise(storage.put(new Uint8Array([1, 2, 3])))
  await bucket.put(`corrupt/${reference.algorithm}:${reference.digest}`, new Uint8Array([9]))
  const error = await Effect.runPromise(storage.get(reference).pipe(Effect.flip))
  expect(error).toMatchObject({ reason: "Integrity", reference })
})
