import { Context, Effect, Layer } from "effect"
import { createBunHost, methodHttp } from "../../../src/bun"
import { checkpointActor } from "../atoms/checkpoint-actor"
import { atomPopulationKinds, type AtomPopulationKind } from "../atoms/population"

const [storage, kind] = Bun.argv.slice(2)
if (!storage || !atomPopulationKinds.some(candidate => candidate === kind)) throw new Error("Expected checkpoint storage and population kind")
const host = await Effect.runPromise(createBunHost({ actor: checkpointActor(kind as AtomPopulationKind), storage,
  checkpointPolicy: { mode: "threshold", options: { everyEvents: 1 } }, actorContext: Context.pick(), services: () => Layer.empty,
}))
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: methodHttp(host) })
process.stdout.write(`${JSON.stringify({ type: "checkpoint-ready", url: server.url.href, pid: process.pid })}\n`)
