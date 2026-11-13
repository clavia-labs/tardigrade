import { Context, Deferred, Effect, Layer, Schema, type Scope } from "effect"
import { Rpc, RpcGroup, RpcMessage, RpcSchema } from "effect/rpc"
import { Headers } from "effect/http"
import { EffectExecution, ExecutionHandle } from "@clavia/tardigrade-core"
import { jsonSchemaOf } from "@clavia/tardigrade-core/json-schema"
import { ToolError } from "./errors"
import { StoredToolResult, isToolResultSchema } from "@clavia/tardigrade-model/object/content"
import { persistToolResult } from "@clavia/tardigrade-model/object/tool-result"
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

/**
 * LibraryDefinition describes a library whose handlers are bound explicitly.
 * @deprecated Use Library.make to derive a service tag from RPC contracts.
 */
export interface LibraryDefinition<Rpcs extends Rpc.Any = Rpc.Any> extends LibraryContract {
  readonly methods: RpcGroup.RpcGroup<Rpcs>
  /**
   * implement binds handlers to the library contract.
   * @deprecated Supply implementations through Layer.succeed or Layer.effect with the library tag.
   */
  readonly implement: BindLibrary<Rpcs>
}

type BindLibrary<Rpcs extends Rpc.Any> = <Handlers extends RpcGroup.HandlersFrom<Rpcs>>(handlers: Handlers, options?: {
  readonly submit?: readonly Rpcs["_tag"][]
  readonly cancel?: Partial<Record<Rpcs["_tag"], (handle: ExecutionHandle | undefined, call: ToolInvocation) => Effect.Effect<void, Error, Exclude<RpcGroup.HandlersServices<Rpcs, Handlers>, EffectExecution>>>>
}) => LibraryImplementation<RpcGroup.HandlersServices<Rpcs, Handlers> | EffectExecution> & { readonly library: LibraryContract & { readonly methods: RpcGroup.RpcGroup<Rpcs> } }

export interface LibraryImplementation<R = never> {
  readonly library: LibraryContract
  readonly methods: readonly LibraryMethod<R>[]
}
export interface LibraryMethod<R = never> extends AgentTool<R> {
  readonly contentResult: boolean
  readonly invoke: (input: unknown, call: ToolInvocation) => Effect.Effect<Schema.Json, Error, R>
}
export type LibraryRequirements<L> = L extends LibraryImplementation<infer R> ? R
  : L extends { readonly rpcLayer: infer Binding extends Layer.Any } ? Layer.Services<Binding> | EffectExecution
  : never
export type LibraryExecutionRequirements<L> = L extends LibraryImplementation<infer R> ? R
  : L extends { readonly rpcLayer: infer Binding extends Layer.Any } ? Layer.Success<Binding> | EffectExecution
  : never

// LibraryRpc restricts adapters to schemas that decode requests and encode responses without services.
export interface LibraryRpc extends Rpc.AnyWithProps {
  readonly payloadSchema: Schema.Top & { readonly DecodingServices: never }
  readonly successSchema: Schema.Top & { readonly EncodingServices: never }
  readonly errorSchema: Schema.Top & { readonly EncodingServices: never }
}

// MethodIdentity retains the library and method names before RPC qualification.
class MethodIdentity extends Context.Service<MethodIdentity, {
  readonly library: string
  readonly method: string
}>()("tardie/library/MethodIdentity") {}

export type LibraryContextSource<E = never, R = never> = string | Effect.Effect<string, E, R>

export interface LibraryContextOptions {
  readonly system?: LibraryContextSource<unknown, unknown> | null
  readonly user?: LibraryContextSource<unknown, unknown> | null
}

class ContextAnnotation extends Context.Service<ContextAnnotation, LibraryContextOptions>()("tardie/library/Context") {}

declare const LibraryContextTypeId: unique symbol
type ContextSlot = keyof LibraryContextOptions
type ExistingSlot<L, K extends ContextSlot> = L extends { readonly [LibraryContextTypeId]: infer Slots }
  ? K extends keyof Slots ? Slots[K] : never
  : never
type PatchedSlot<L, P, K extends ContextSlot> = P extends null ? never
  : K extends keyof P ? P[K] | ({} extends Pick<P, K> ? ExistingSlot<L, K> : never)
  : ExistingSlot<L, K>
type ContextSources<L> = ExistingSlot<L, "system"> | ExistingSlot<L, "user">

export type LibraryContextRequirements<L> = Effect.Services<ContextSources<L>>
export type LibraryContextError<L> = Effect.Error<ContextSources<L>>

// context patches lazy prompt sources; null clears a slot or the entire contribution.
function context<const P extends LibraryContextOptions | null>(options: P) {
  return <L extends RpcLibraryBinding>(library: L): Omit<L, typeof LibraryContextTypeId> & {
    readonly [LibraryContextTypeId]: { readonly [K in ContextSlot]: PatchedSlot<L, P, K> }
  } => {
    const previous = Context.getOrUndefined(library.rpc.annotations, ContextAnnotation)
    const sources = {
      system: options === null ? null : options.system === undefined ? previous?.system ?? null : options.system,
      user: options === null ? null : options.user === undefined ? previous?.user ?? null : options.user,
    }
    const rpc = RpcGroup.make(...library.rpc.requests.values()).annotateMerge(
      Context.add(library.rpc.annotations, ContextAnnotation, sources),
    )
    const decorated = Object.create(library) as Omit<L, typeof LibraryContextTypeId> & {
      readonly [LibraryContextTypeId]: { readonly [K in ContextSlot]: PatchedSlot<L, P, K> }
    }
    return Object.assign(decorated, { rpc })
  }
}

type BoundHandlers<Rpcs extends Rpc.Any, Requirements> = {
  readonly [Method in Rpcs as Method["_tag"]]: Rpc.ToHandlerFn<Method, Requirements>
}

export interface RpcLibraryBinding<Rpcs extends LibraryRpc = LibraryRpc, Requirements = unknown> {
  readonly name: string
  readonly rpc: Pick<RpcGroup.RpcGroup<Rpcs>, "requests" | "annotations">
  readonly rpcLayer: Layer.Layer<never, never, Requirements>
}

// LibraryBinding accepts service-backed contracts and legacy handler implementations.
export type LibraryBinding = LibraryImplementation<unknown> | RpcLibraryBinding

export interface LibraryContextContribution {
  readonly library: string
  readonly system?: string
  readonly user?: string
}

// libraryContextSources reads declarations without evaluating their effects.
export function libraryContextSources(libraries: readonly LibraryBinding[]) {
  return libraries.flatMap(library => {
    if (!("rpc" in library)) return []
    const sources = Context.getOrUndefined(library.rpc.annotations, ContextAnnotation)
    return sources ? [{ library: library.name, ...sources }] : []
  })
}

// resolveLibraryContext evaluates sources sequentially in library order within the caller's runtime.
export function resolveLibraryContext<const L extends readonly LibraryBinding[]>(libraries: L, options: { readonly dynamicOnly?: boolean } = {}): Effect.Effect<
  readonly LibraryContextContribution[], LibraryContextError<L[number]>, LibraryContextRequirements<L[number]>
> {
  type E = LibraryContextError<L[number]>
  type R = LibraryContextRequirements<L[number]>
  const resolve = (source: LibraryContextSource<E, R> | null | undefined) =>
    typeof source === "string" ? options.dynamicOnly ? Effect.void : Effect.succeed(source) : source ?? Effect.void
  return Effect.gen(function* () {
    const contributions: LibraryContextContribution[] = []
    for (const entry of libraryContextSources(libraries)) {
      const sources = entry as { readonly [K in ContextSlot]?: LibraryContextSource<E, R> | null }
      const system = yield* resolve(sources.system)
      const user = yield* resolve(sources.user)
      if (system === undefined && user === undefined) continue
      contributions.push({
        library: entry.library,
        ...(system === undefined ? {} : { system }),
        ...(user === undefined ? {} : { user }),
      })
    }
    return contributions
  })
}

// libraryImplementations adapts service-backed declarations and retains existing implementations.
export function libraryImplementations<const L extends readonly LibraryBinding[]>(libraries: L): readonly LibraryImplementation<LibraryExecutionRequirements<L[number]>>[] {
  return libraries.map(library => "rpc" in library ? rpcLibraryTools(library) : library) as readonly LibraryImplementation<LibraryExecutionRequirements<L[number]>>[]
}

// libraryBindings installs RPC handlers in the owning runtime scope (platform/test/bun/library-scope.test.ts).
export function libraryBindings<const L extends readonly LibraryBinding[]>(libraries: L) {
  type Bound = Extract<L[number], { readonly rpcLayer: Layer.Layer<never, never, LibraryRequirements<L[number]>> }>
  const bindings = libraries.filter((library): library is Bound => "rpcLayer" in library)
  const layers = bindings.map((library): Bound["rpcLayer"] => library.rpcLayer)
  return Layer.mergeAll(Layer.empty, ...layers)
}

declare const LibraryIdentityTypeId: unique symbol
interface LibraryIdentity<Name extends string, Rpcs extends Rpc.Any> {
  readonly [LibraryIdentityTypeId]: { readonly name: Name; readonly methods: Rpcs }
}

type LibraryService<Rpcs extends Rpc.Any> = {
  readonly [Method in Rpcs as Method["_tag"]]: (
    input: Rpc.Payload<Method>,
    request?: Parameters<Rpc.ToHandlerFn<Method>>[1],
  ) => Effect.Effect<Rpc.Success<Method>, Rpc.Error<Method>, Scope.Scope>
}

export interface Library<Name extends string = string, Rpcs extends Rpc.Any = Rpc.Any>
  extends Context.Service<LibraryIdentity<Name, Rpcs>, LibraryService<Rpcs>> {
  readonly name: Name
  readonly rpc: RpcGroup.RpcGroup<Rpc.Prefixed<Rpcs, `${Name}__`>>
  readonly rpcLayer: Layer.Layer<Rpc.ToHandler<Rpc.Prefixed<Rpcs, `${Name}__`>>, never, LibraryIdentity<Name, Rpcs> | RpcGroup.HandlersServices<Rpc.Prefixed<Rpcs, `${Name}__`>, BoundHandlers<Rpc.Prefixed<Rpcs, `${Name}__`>, Scope.Scope>>>
}

// makeLibrary derives an Effect service tag and RPC bindings from a named contract.
function makeLibrary<const Name extends string, const Rpcs extends readonly LibraryRpc[]>(
  name: Name,
  ...methods: Rpcs
): Library<Name, Rpcs[number]> {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) throw new Error(`Invalid library name: ${name}`)
  if (name.includes("__")) throw new Error(`Library name contains reserved separator "__": ${name}`)
  if (name.endsWith("_")) throw new Error(`Library name ends with reserved boundary "_": ${name}`)
  const names = methods.map(method => method._tag)
  if (new Set(names).size !== names.length) throw new Error(`Duplicate method in ${name}`)
  const groups = methods.map((method: Rpcs[number]) => {
    if (!/^[A-Za-z_$][\w$]*$/.test(method._tag)) throw new Error(`Invalid method name: ${method._tag}`)
    if (method._tag.includes("__")) throw new Error(`Method name contains reserved separator "__": ${method._tag}`)
    if (method._tag.startsWith("_")) throw new Error(`Method name starts with reserved boundary "_": ${method._tag}`)
    if (method.middlewares.size || RpcSchema.isStreamSchema(method.successSchema)) throw new Error("Library adapters require unary RPCs without middleware")
    return RpcGroup.make(method).annotateRpcs(MethodIdentity, { library: name, method: method._tag })
  })
  type Qualified = Rpc.Prefixed<Rpcs[number], `${Name}__`>
  const rpc: RpcGroup.RpcGroup<Qualified> = RpcGroup.make().merge(...groups).prefix(`${name}__`)
  const service: Context.Service<LibraryIdentity<Name, Rpcs[number]>, LibraryService<Rpcs[number]>> = Context.Service<LibraryIdentity<Name, Rpcs[number]>, LibraryService<Rpcs[number]>>()(`tardie/library/${name}`)
  const handlers = Effect.map(service, implementation => Object.fromEntries(
    Array.from(rpc.requests.values(), method => {
      const identity = Context.getUnsafe(method.annotations, MethodIdentity)
      const handler = implementation[identity.method as keyof typeof implementation] as Rpc.ToHandlerFn<Rpcs[number], Scope.Scope>
      return [method._tag, handler.bind(implementation)]
    }),
  ) as unknown as BoundHandlers<Qualified, Scope.Scope>)
  const named = Object.defineProperty(service, "name", { value: name, configurable: true }) as typeof service & { readonly name: Name }
  return Object.assign(named, { rpc, rpcLayer: rpc.toLayer(handlers) })
}

// Library constructs service-backed RPC contracts.
export const Library = { make: makeLibrary, context }

// rpcLibraryTools connects bound RPC handlers to the durable tool execution adapter.
function rpcLibraryTools<Rpcs extends LibraryRpc, Requirements>(binding: RpcLibraryBinding<Rpcs, Requirements>) {
  const methods = Array.from(binding.rpc.requests.values())
  const rpc = RpcGroup.make(...methods).annotateMerge(binding.rpc.annotations)
  const compiled = compileLibrary({ name: binding.name, description: binding.name, methods })
  const handlers = Object.fromEntries(methods.map(method => [method._tag, (
    payload: Rpc.Payload<Rpcs>, options: Parameters<Rpc.ToHandlerFn<Rpcs>>[1],
  ) => Effect.flatMap(rpc.accessHandler(method._tag), handler => {
    const result = handler(payload, options)
    if (!Effect.isEffect(result)) return Effect.die(new ToolError("Library adapters require unary RPC handlers"))
    return result.pipe(Effect.mapError(error => error as Rpc.Error<Rpcs>))
  })])) as unknown as BoundHandlers<Rpcs, Rpc.ToHandler<Rpcs>>
  return compiled.bind(handlers)
}

interface LibraryDeclaration<Rpcs extends readonly LibraryRpc[]> {
  readonly name: string
  readonly description: string
  readonly methods: Rpcs
  readonly toolNames?: Readonly<Partial<Record<Rpcs[number]["_tag"], string>>>
}

/**
 * defineLibrary names an Effect RPC group and derives its model-facing method contracts.
 * @deprecated Use Library.make and supply implementations through an Effect layer.
 */
export function defineLibrary<const Rpcs extends readonly LibraryRpc[]>(definition: LibraryDeclaration<Rpcs>): LibraryDefinition<Rpcs[number]> {
  const { library, bind } = compileLibrary(definition)
  return { ...library, implement: bind }
}

// compileLibrary derives tool contracts and durable handler bindings from RPC declarations.
function compileLibrary<const Rpcs extends readonly LibraryRpc[]>(definition: LibraryDeclaration<Rpcs>) {
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
    const identity = Context.getOrUndefined(rpc.annotations, MethodIdentity)
    const method = identity?.method ?? rpc._tag
    const name = definition.toolNames?.[rpc._tag as Rpcs[number]["_tag"]] ?? `${definition.name}__${method}`
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid tool name: ${name}`)
    return {
      name, method, description,
      inputSchema: jsonSchemaOf(rpc.payloadSchema === Schema.Void ? Schema.Struct({}) : rpc.payloadSchema, { onExcessProperty: "error" }),
      outputSchema: jsonSchemaOf(rpc.successSchema === Schema.Void ? Schema.Null : rpc.successSchema),
      ...(annotations ? { annotations } : {}), execution, ...(promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs }),
    }
  })
  for (const name of Object.keys(definition.toolNames ?? {})) if (!names.includes(name)) throw new Error(`Unknown method in ${definition.name}: ${name}`)
  const library = { name: definition.name, description: definition.description, specs, methods }
  const bind: BindLibrary<Rpcs[number]> = (handlers, options = {}) => {
    type R = RpcGroup.HandlersServices<Rpcs[number], typeof handlers>
    const implementations = handlers as unknown as Record<string, (payload: unknown, options: {
      readonly client: Rpc.ServerClient; readonly requestId: RpcMessage.RequestId; readonly headers: Headers.Headers; readonly rpc: Rpc.Any
    }) => Effect.Effect<unknown, Rpc.Error<Rpcs[number]>, R>>
    for (const name of options.submit ?? []) if (!names.includes(name)) throw new Error(`Unknown submitted method: ${name}`)
    for (const name of Object.keys(options.cancel ?? {})) if (!names.includes(name)) throw new Error(`Unknown cancelled method: ${name}`)
    for (const name of names) if (typeof implementations[name] !== "function") throw new Error(`Missing library handler: ${name}`)
    const compiled = definition.methods.map((rpc, index): LibraryMethod<R | EffectExecution> => {
      const spec = specs[index]!
      const run = (payload: unknown, call: ToolInvocation) => Effect.gen(function* () {
        const handler = implementations[rpc._tag]
        if (!handler) return yield* Effect.fail(new ToolError(`Missing library handler: ${rpc._tag}`))
        const result = handler(rpc.payloadSchema === Schema.Void ? undefined : payload, { client: new Rpc.ServerClient(0), requestId: RpcMessage.RequestId(call.callId), headers: Headers.empty, rpc })
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
      const contentResult = isToolResultSchema(rpc.successSchema)
      const output = (payload: unknown, call: ToolInvocation) => run(payload, call).pipe(Effect.flatMap(contentResult ? persistToolResult : Schema.decodeUnknownEffect(Schema.Json)))
      const invoke = (payload: unknown, call: ToolInvocation) => Schema.decodeUnknownEffect(input, { onExcessProperty: "error" })(payload).pipe(Effect.flatMap(value => output(value, call)), Effect.mapError(ToolError.from))
      const description = spec.description
      if (options.submit?.includes(rpc._tag)) {
        if (spec.execution !== "background") throw new Error(`Submitted method must use background execution: ${rpc._tag}`)
        return { invoke, contentResult, ...promiseTool({ name: rpc._tag, description, input,
          ...(spec.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: spec.promiseTimeoutMs }),
          submit: (payload, call) => run(payload, call).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ExecutionHandle))),
          ...(options.cancel?.[rpc._tag as Rpcs[number]["_tag"]] ? { cancel: options.cancel[rpc._tag as Rpcs[number]["_tag"]] } : {}),
          ...(spec.annotations ? { annotations: spec.annotations } : {}),
        }) }
      }
      return { invoke, contentResult, ...tool({ name: spec.method, description, input,
        run: (payload, call) => output(payload, call).pipe(Effect.flatMap(value => contentResult
          ? Schema.decodeUnknownEffect(StoredToolResult)(value)
          : Effect.succeed({ content: [{ type: "text" as const, text: JSON.stringify(value) }] }))),
        ...(spec.promiseTimeoutMs === undefined ? {} : { promiseTimeoutMs: spec.promiseTimeoutMs }),
        ...(spec.annotations ? { annotations: spec.annotations } : {}), execution: spec.execution,
      }) }
    })
    return { library, methods: compiled }
  }
  return { library, bind }
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
