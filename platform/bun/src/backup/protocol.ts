import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { Transferable } from "effect/unstable/workers"

export const CheckpointRpcs = RpcGroup.make(Rpc.make("capture", {
  payload: {
    actor: Schema.String,
    storage: Schema.String,
    temporary: Schema.String,
    maxBytes: Schema.Finite
  },
  success: Schema.Struct({
    id: Schema.String,
    actor: Schema.String,
    createdAt: Schema.Finite,
    digest: Schema.String,
    payload: Transferable.Uint8Array
  }),
  error: Schema.String
}))
