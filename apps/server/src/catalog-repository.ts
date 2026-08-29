import { Effect, Layer, Schema } from "effect"
import { FileSystem } from "effect/FileSystem"
import { createHash, randomUUID } from "node:crypto"
import { dirname } from "node:path"
import { ModelCatalog as ModelCatalogSchema, type ModelCatalog } from "@clavia/tardigrade-client/contract"
import {
  ModelCatalogRepository,
  ModelCatalogRepositoryError,
  modelCatalogScopeOf,
  type ModelCatalogRepositoryService
} from "./catalog-store"

export { ModelCatalogRepository, ModelCatalogRepositoryError } from "./catalog-store"

const sourceKeyOf = (sourceUrl: string): string =>
  `sha256:${createHash("sha256").update(sourceUrl).digest("hex")}`

const repositoryError = (message: string, cause?: unknown): ModelCatalogRepositoryError =>
  new ModelCatalogRepositoryError({ message, ...(cause === undefined ? {} : { cause }) })

const decoded = (raw: string, sourceUrl: string): ModelCatalog | undefined => {
  const stored = JSON.parse(raw) as { readonly schema?: unknown; readonly sourceKey?: unknown; readonly snapshot?: unknown }
  if (stored.schema !== 1 || stored.sourceKey !== sourceKeyOf(sourceUrl)) return undefined
  const snapshot = Schema.decodeUnknownSync(ModelCatalogSchema)(stored.snapshot)
  if (snapshot.providers.every((provider) => provider.models.length === 0)) return undefined
  return { ...snapshot, status: "cached" }
}

// layerFileModelCatalogRepository stores one snapshot as an atomic JSON file.
export const layerFileModelCatalogRepository = (cachePath: string): Layer.Layer<ModelCatalogRepository, never, FileSystem> =>
  Layer.effect(
    ModelCatalogRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem
      return {
        read: (sourceUrl) => fs.readFileString(cachePath).pipe(
          Effect.catch((error) => error.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(repositoryError(`could not read model catalog cache ${JSON.stringify(cachePath)}`, error))),
          Effect.flatMap((raw) => Effect.try({
            try: () => raw === undefined ? undefined : decoded(raw, sourceUrl),
            catch: (cause) => repositoryError(`model catalog cache ${JSON.stringify(cachePath)} is invalid`, cause)
          }))
        ),
        readScope: (sourceUrl, scope) => fs.readFileString(cachePath).pipe(
          Effect.catch((error) => error.reason._tag === "NotFound"
            ? Effect.void
            : Effect.fail(repositoryError(`could not read model catalog cache ${JSON.stringify(cachePath)}`, error))),
          Effect.flatMap((raw) => Effect.try({
            try: () => {
              const snapshot = raw === undefined ? undefined : decoded(raw, sourceUrl)
              return snapshot === undefined ? undefined : modelCatalogScopeOf(snapshot, scope)
            },
            catch: (cause) => repositoryError(`model catalog cache ${JSON.stringify(cachePath)} is invalid`, cause)
          }))
        ),
        write: (sourceUrl, snapshot) => {
          const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
          return Effect.gen(function*() {
            yield* fs.makeDirectory(dirname(cachePath), { recursive: true })
            yield* fs.writeFileString(
              temporary,
              `${JSON.stringify({ schema: 1, sourceKey: sourceKeyOf(sourceUrl), snapshot })}\n`,
              { mode: 0o644 }
            )
            yield* fs.rename(temporary, cachePath)
          }).pipe(
            Effect.mapError((cause) => repositoryError(`could not write model catalog cache ${JSON.stringify(cachePath)}`, cause)),
            Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore))
          )
        }
      } satisfies ModelCatalogRepositoryService
    })
  )
