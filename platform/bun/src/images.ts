import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { ImageStore, type StoredImage } from "@clavia/tardigrade-core/interaction/image"

const PREFIX = "tardigrade:image:sha256:"

const digestOf = (image: StoredImage): Effect.Effect<string> => Effect.promise(async () => {
  const media = new TextEncoder().encode(`${image.mediaType}\0`)
  const value = new Uint8Array(media.byteLength + image.bytes.byteLength)
  value.set(media)
  value.set(image.bytes, media.byteLength)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value)).toHex()
})

// bunImageStore stores actor-instance image bytes in the actor directory database.
export const bunImageStore = (sql: SqlClient.SqlClient): typeof ImageStore.Service => ({
  egress: "resolve",
  owns: (reference) => reference.startsWith(PREFIX),
  put: (image) => Effect.gen(function* () {
    const reference = `${PREFIX}${yield* digestOf(image)}`
    yield* sql`INSERT INTO images (reference, media_type, bytes)
      VALUES (${reference}, ${image.mediaType}, ${image.bytes})
      ON CONFLICT(reference) DO NOTHING`.pipe(Effect.asVoid, Effect.orDie)
    return reference
  }),
  get: (reference) => Effect.gen(function* () {
    if (!new RegExp(`^${PREFIX}[0-9a-f]{64}$`).test(reference)) return undefined
    const rows = yield* sql<{ readonly media_type: string; readonly bytes: Uint8Array }>`
      SELECT media_type, bytes FROM images WHERE reference = ${reference}
    `.pipe(Effect.orDie)
    if (rows[0] === undefined) return undefined
    const image = { mediaType: rows[0].media_type, bytes: rows[0].bytes }
    if (`${PREFIX}${yield* digestOf(image)}` !== reference) {
      return yield* Effect.die(new Error(`stored image ${JSON.stringify(reference)} failed its digest check`))
    }
    return image
  })
})
