import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Path } from "effect/Path"
import { ObjectStorage, makeObjectStorage, sqlObjectStorage, type LocalObjectStorageOptions } from "@clavia/tardigrade-model/object"

// objectStorageFromSqlite shares objects through the supplied database across host restarts.
export const objectStorageFromSqlite = (
  config: SqliteClient.SqliteClientConfig,
  options: LocalObjectStorageOptions = {}
) => Layer.effect(ObjectStorage, sqlObjectStorage(options)).pipe(Layer.provide(SqliteClient.layer(config)))

export const DEFAULT_FILE_OBJECT_PREFIX = "objects"

export interface FileObjectStorageOptions {
  readonly prefix?: string
}

// objectStorageFromFileSystem stores content-addressed objects below a platform-provided directory.
export const objectStorageFromFileSystem = (
  directory: string,
  options: FileObjectStorageOptions = {},
) => Layer.effect(ObjectStorage, Effect.gen(function* () {
  const fs = yield* FileSystem
  const path = yield* Path
  const prefix = options.prefix ?? DEFAULT_FILE_OBJECT_PREFIX
  const root = path.join(directory, prefix)
  yield* fs.makeDirectory(root, { recursive: true })
  return makeObjectStorage({
    read: key => Effect.gen(function* () {
      const file = path.join(root, key.replace(":", path.sep))
      const present = yield* fs.exists(file)
      if (!present) return undefined
      return yield* fs.readFile(file)
    }),
    write: (key, bytes) => Effect.gen(function* () {
      const file = path.join(root, key.replace(":", path.sep))
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFile(file, bytes)
    }),
  })
}))
