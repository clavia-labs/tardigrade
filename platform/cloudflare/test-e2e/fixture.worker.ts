import { defineWorkerHost, workerHttp } from "../src/worker"
import { definition, modelLayer } from "../../../e2e/inference/contract"
import { Layer } from "effect"
import { objectStorageFromR2 } from "../src/object-storage/r2"
import type { Env } from "../src/env"

const host = defineWorkerHost(definition, { layersFor: ({ env, storage }: { env: Env & { OBJECTS: R2Bucket }; storage: DurableObjectStorage }) => Layer.merge(
  modelLayer("https://provider.test"),
  objectStorageFromR2(env.OBJECTS, { cache: { storage, namespace: "OBJECTS" } })
) })
export const { ActorDO, ThreadDO } = host
export default workerHttp(host)
