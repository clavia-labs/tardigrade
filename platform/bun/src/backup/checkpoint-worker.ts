import { BunWorkerRunner } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { captureHostCheckpoint } from "./index"
import { CheckpointRpcs } from "./protocol"

const handlers = CheckpointRpcs.toLayer({
  capture: ({ actor, storage, maxBytes, temporary }) => Effect.try({
    try: () => {
      const checkpoint = captureHostCheckpoint({ actor, storage, policy: { maxBytes } }, temporary)
      return { ...checkpoint, payload: new Uint8Array(checkpoint.payload) }
    },
    catch: (cause) => cause instanceof Error ? cause.message : String(cause)
  })
})

const server = RpcServer.layer(CheckpointRpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BunWorkerRunner.layer)
)

Effect.runFork(Layer.launch(server))
