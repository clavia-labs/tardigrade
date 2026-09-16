import { providerLayer } from "tardie/model/providers/openrouter"
import definition from "./actor"
import { defineWorkerHost, workerHttp, workerModelServices, modelScopeFrom, objectStorageFromR2, type Env, type WorkerHost } from "tardie/worker"
import { Effect, Layer } from "effect"
import { ObjectStorage } from "tardie/agent"
import { uploadLimit, uploadResponse } from "./uploads"
import modelLock from "./models.lock.json"

const services = workerModelServices({
  model: { providerLayer },
  scope: modelScopeFrom(modelLock)
})

interface ChatEnv extends Env {
  readonly OBJECTS?: R2Bucket
  readonly CHAT_MAX_UPLOAD_BYTES?: string
}

const host: WorkerHost<ChatEnv> = defineWorkerHost(definition, {
  authentication: "none",
  services,
  layersFor: ({ env, storage }) => env.OBJECTS === undefined ? Layer.empty : objectStorageFromR2(env.OBJECTS, { cache: { storage, bucketNamespace: "OBJECTS" } })
})
const http = workerHttp(host)

// host exposes the HTTP handler and Durable Object classes (platform/cloudflare/test/actor.workers.ts).
// HTTP request -> Worker handler
//                  +-- ActorDO: allocates and tracks threads
//                  +-- ThreadDO: stores events and executes a thread
export const { ActorDO, ThreadDO } = host

export default {
  fetch: async (request, env, context) => {
    if (new URL(request.url).pathname !== "/v1/objects") return http.fetch(request, env, context)
    if (env.OBJECTS === undefined) return Response.json({ error: "Attachments require the OBJECTS R2 binding" }, { status: 503 })
    const storage = await Effect.runPromise(ObjectStorage.pipe(Effect.provide(objectStorageFromR2(env.OBJECTS))))
    return uploadResponse(request, storage, {
      maxUploadBytes: uploadLimit(env.CHAT_MAX_UPLOAD_BYTES)
    })
  }
} satisfies ExportedHandler<ChatEnv>
