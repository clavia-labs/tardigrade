import { Context, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Rpc, RpcGroup, RpcSchema } from "effect/rpc"
import { MethodDescription } from "./library"

const EmptyParameters = Schema.Struct({})

type RpcTools<Rpcs extends Rpc.AnyWithProps> = {
  readonly [Method in Rpcs as Method["_tag"]]: Tool.Tool<Method["_tag"], {
    readonly parameters: Method["payloadSchema"] extends typeof Schema.Void ? typeof EmptyParameters : Method["payloadSchema"]
    readonly success: Method["successSchema"]
    readonly failure: Method["errorSchema"]
    readonly failureMode: "error"
  }>
}

// toolkitFromRpc derives model tool definitions without installing or executing handlers.
export function toolkitFromRpc<Rpcs extends Rpc.AnyWithProps>(group: Pick<RpcGroup.RpcGroup<Rpcs>, "requests" | "annotations">): Toolkit.Toolkit<RpcTools<Rpcs>> {
  const tools = Array.from(group.requests.values(), rpc => {
    if (RpcSchema.isStreamSchema(rpc.successSchema)) throw new Error(`Model tools require unary RPCs: ${rpc._tag}`)
    const annotations = Context.merge(group.annotations, rpc.annotations)
    return Tool.make(rpc._tag, {
      description: Context.getOrUndefined(annotations, MethodDescription) ?? rpc._tag,
      parameters: rpc.payloadSchema === Schema.Void ? EmptyParameters : rpc.payloadSchema,
      success: rpc.successSchema,
      failure: rpc.errorSchema,
    }).annotateMerge(annotations)
  })
  return Toolkit.make(...tools) as unknown as Toolkit.Toolkit<RpcTools<Rpcs>>
}
