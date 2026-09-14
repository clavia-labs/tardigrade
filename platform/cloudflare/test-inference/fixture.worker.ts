import { defineWorkerHost, workerHttp } from "../src/worker"
import { definition, modelLayer } from "../../../e2e/inference/contract"

const host = defineWorkerHost(definition, { layersFor: () => modelLayer("https://provider.test") })
export const { ActorDO, ThreadDO } = host
export default workerHttp(host)
