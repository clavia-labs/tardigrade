import { Context, Deferred, Effect, Schema } from "effect"
import { Rpc, RpcGroup, RpcSchema } from "effect/rpc"
import { RequestId } from "effect/rpc/RpcMessage"
import * as Headers from "effect/http/Headers"
import { EffectExecution, ExecutionHandle } from "@clavia/tardigrade-core"
import { jsonSchemaOf } from "@clavia/tardigrade-core/json-schema"
import { ToolError } from "./errors"
import { tool, promiseTool, type AgentTool, type ToolInvocation } from "./tool"
import { MethodAnnotations, ExecutionMode, DEFAULT_METHOD_EXECUTION, type LibraryContract, type ToolSpec } from "./types"

// MethodDescription describes a library method to models and RPC clients.
export class MethodDescription extends Context.Service<MethodDescription, string>()("tardie/library/MethodDescription") {}
// MethodHints carries MCP-compatible behaviour hints; adapters do not enforce permissions from these hints.
export class MethodHints extends Context.Service<MethodHints, MethodAnnotations>()("tardie/library/MethodHints") {}
// MethodExecution selects whether a call waits for a value or returns a durable background handle.
export class MethodExecution extends Context.Service<MethodExecution, ExecutionMode>()("tardie/library/MethodExecution") {}
// MethodPromiseTimeout sets the background promise waiting budget in milliseconds; omission inherits the host policy.
export class MethodPromiseTimeout extends Context.Service<MethodPromiseTimeout, number>()("tardie/library/MethodPromiseTimeout") {}

export interface Library<Rpcs extends Rpc.Any = Rpc.Any> extends LibraryContract {
  readonly methods: RpcGroup.RpcGroup<Rpcs>
  readonly implement: <Handlers extends RpcGroup.HandlersFrom<Rpcs>>(handlers: Handlers, options?: {
    readonly submit?: readonly Rpcs["_tag"][]
    readonly cancel?: Partial<Record<Rpcs["_tag"], (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<RpcGroup.HandlersServices<Rpcs, Handlers>, EffectExecution>>>>
  }) => LibraryImplementation<RpcGroup.HandlersServices<Rpcs, Handlers> | EffectExecution> & { readonly library: LibraryContract & { readonly methods: RpcGroup.RpcGroup<Rpcs> } }
}

export interface LibraryImplementation<R = never> {
  readonly library: LibraryContract
  readonly methods: readonly AgentTool<R>[]
}
export type LibraryRequirements<L> = L extends LibraryImplementation<infer R> ? R : never

// LibraryRpc restricts adapters to schemas that decode requests and encode responses without services.
export interface LibraryRpc extends Rpc.AnyWithProps {
  readonly payloadSchema: Schema.Top & { readonly DecodingServices: never }
  readonly successSchema: Schema.Top & { readonly EncodingServices: never }
  readonly errorSchema: Schema.Top & { readonly EncodingServices: never }
}

// defineLibrary names an Effect RPC group and derives its model-facing method contracts.
export function defineLibrary<const Rpcs extends readonly LibraryRpc[]>(definition: {
  readonly name: string
  readonly description: string
  readonly methods: Rpcs
  readonly toolNames?: Readonly<Partial<Record<Rpcs[number]["_tag"], string>>>
}): Library<Rpcs[number]> {
  if (!/^[A-Za-z_$][\w$]*$/.test(definition.name)) throw new Error(`Invalid library name: ${definition.name}`)
  const names = definition.methods.map(method => method._tag)
  if (new Set(names).size !== names.length) throw new Error(`Duplicate method in ${definition.name}`)
  const methods = RpcGroup.make(...definition.methods)
  const specs = definition.methods.map(rpc => {
    if (!/^[A-Za-z_$][\w$]*$/.test(rpc._tag)) throw new Error(`Invalid method name: ${rpc._tag}`)
    if (rpc.middlewares.size || RpcSchema.isStreamSchema(rpc.successSchema)) throw new Error("Library adapters require unary RPCs without middleware")
    const description = Context.getOrUndefined(rpc.annotations, MethodDescription) ?? rpc._tag
    const hints = Context.getOrUndefined(rpc.annotations, MethodHints)
    const annotations = hints ? Schema.decodeSync(MethodAnnotations)(hints) : undefined
    const execution = Schema.decodeSync(ExecutionMode)(Context.getOrUndefined(rpc.annotations, MethodExecution) ?? DEFAULT_METHOD_EXECUTION)
    const promiseTimeoutMs = Context.getOrUndefined(rpc.annotations, MethodPromiseTimeout)
    if (promiseTimeoutMs !== undefined && (!Number.isSafeInteger(promiseTimeoutMs) || promiseTimeoutMs < 1)) throw new Error("MethodPromiseTimeout must be a positive safe integer")
    if (promiseTimeoutMs !== undefined && execution !== "background") throw new Error("MethodPromiseTimeout requires background execution")
    const name = definition.toolNames?.[rpc._tag as Rpcs[number]["_tag"]] ?? `${definition.name}__${rpc._tag}`
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`)
    return {
      name, method: rpc._tag, description,
      inputSchema: jsonSchemaOf(rpc.payloadSchema === Schema.Void ? Schema.Struct({}) : rpc.payloadSchema, { onExcessProperty: "error" }),
      outputSchema: jsonSchemaOf(rpc.successSchema === Schema.Void ? Schema.Null : rpc.successSchema),
      ...(annotations ? { annotations } : {}), execution, ...(promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs }),
    }
  })
  for (const name of Object.keys(definition.toolNames ?? {})) if (!names.includes(name)) throw new Error(`Unknown method in ${definition.name}: ${name}`)
  const library = { name: definition.name, description: definition.description, specs, methods }
  return { ...library, implement: (handlers, options = {}) => {
    type R = RpcGroup.HandlersServices<Rpcs[number], typeof handlers>
    const implementations = handlers as unknown as Record<string, (payload: unknown, options: {
      readonly client: Rpc.ServerClient; readonly requestId: RequestId; readonly headers: Headers.Headers; readonly rpc: Rpc.Any
    }) => Effect.Effect<unknown, Rpc.Error<Rpcs[number]>, R>>
    for (const name of options.submit ?? []) if (!names.includes(name)) throw new Error(`Unknown submitted method: ${name}`)
    for (const name of Object.keys(options.cancel ?? {})) if (!names.includes(name)) throw new Error(`Unknown cancelled method: ${name}`)
    for (const name of names) if (typeof implementations[name] !== "function") throw new Error(`Missing library handler: ${name}`)
    const compiled = definition.methods.map((rpc, index): AgentTool<R | EffectExecution> => {
      const spec = specs[index]!
      const run = (payload: unknown, call: ToolInvocation) => Effect.gen(function* () {
        const handler = implementations[rpc._tag]
        if (!handler) return yield* Effect.fail(new ToolError(`Missing library handler: ${rpc._tag}`))
        const result = handler(rpc.payloadSchema === Schema.Void ? undefined : payload, { client: new Rpc.ServerClient(0), requestId: RequestId(call.callId), headers: Headers.empty, rpc })
        if (!Effect.isEffect(result)) return yield* Effect.fail(new ToolError("Library handlers must return an Effect"))
        const value = yield* result
        const resolved = Deferred.isDeferred(value) ? yield* Deferred.await(value as Deferred.Deferred<unknown, Rpc.Error<Rpcs[number]>>).pipe(Effect.mapError(ToolError.from)) : value
        const encoded = yield* Schema.encodeUnknownEffect(rpc.successSchema as Schema.ConstraintEncoder<unknown>)(resolved)
        return rpc.successSchema === Schema.Void ? null : encoded
      }).pipe(Effect.mapError(error => {
        if (error instanceof Error) return error
        try {
          const encoded = Schema.encodeUnknownSync(rpc.errorSchema as Schema.ConstraintEncoder<unknown>)(error)
          return new ToolError(typeof encoded === "string" ? encoded : JSON.stringify(encoded))
        } catch { return ToolError.from(error) }
      }))
      const input = (rpc.payloadSchema === Schema.Void ? Schema.Struct({}) : rpc.payloadSchema) as Schema.ConstraintDecoder<unknown>
      const description = spec.description
      if (options.submit?.includes(rpc._tag)) {
        if (spec.execution !== "background") throw new Error(`Submitted method must use background execution: ${rpc._tag}`)
        return promiseTool({ name: rpc._tag, description, input,
          ...(spec.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: spec.promiseTimeoutMs }),
          submit: (payload, call) => run(payload, call).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExecutionHandle))),
          ...(options.cancel?.[rpc._tag as Rpcs[number]["_tag"]] ? { cancel: options.cancel[rpc._tag as Rpcs[number]["_tag"]] } : {}),
          ...(spec.annotations ? { annotations: spec.annotations } : {}),
        })
      }
      return tool({ name: rpc._tag, description, input, run,
        ...(spec.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: spec.promiseTimeoutMs }),
        ...(spec.annotations ? { annotations: spec.annotations } : {}), execution: spec.execution,
      })
    })
    return { library, methods: compiled }
  } }
}

// toolsFromLibraries exposes configured tool names while retaining qualified aliases for recorded calls.
export function toolsFromLibraries<const L extends readonly LibraryImplementation<unknown>[]>(libraries: L): readonly AgentTool<LibraryRequirements<L[number]>>[] {
  if (new Set(libraries.map(value => value.library.name)).size !== libraries.length) throw new Error("Duplicate library name")
  const methods = libraries.flatMap(({ library, methods }) => methods.map((method, index) => {
    const spec = library.specs[index]!
    const qualified = `${library.name}__${spec.method}`
    return { ...method, aliases: [...(method.aliases ?? []), ...(spec.name === qualified ? [] : [qualified])],
      spec: { ...spec, description: `${library.description}\n${spec.description}` } satisfies ToolSpec,
    }
  }))
  const names = methods.flatMap(method => [method.spec.name, ...method.aliases])
  if (new Set(names).size !== names.length) throw new Error("Duplicate tool name or alias")
  return methods as readonly AgentTool<LibraryRequirements<L[number]>>[]
}
