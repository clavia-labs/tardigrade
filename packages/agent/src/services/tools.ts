import { Effect, Layer, Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-core"
import { libraryBindings, libraryImplementations, toolkitFromRpc, toolsFromLibraries, type BindableLibrary } from "@clavia/tardigrade-libraries"
import { ToolSpec } from "@clavia/tardigrade-libraries/types"
import { ExecuteTool } from "../contracts/acts"
import { ToolCatalog } from "../actor/context"

// libraryServices supplies the catalog and durable execution adapter for declared libraries.
export function libraryServices<const L extends readonly BindableLibrary[]>(libraries: L, additional: readonly ToolSpec[] = []) {
  const implementations = libraryImplementations(libraries)
  const methods = toolsFromLibraries(implementations)
  const registry = new Map(methods.flatMap(method => [method.spec.name, ...(method.aliases ?? [])].map(name => [name, method] as const)))
  const nativeTools = Object.fromEntries(libraries.flatMap(library => "rpc" in library
    ? Object.entries(toolkitFromRpc(library.rpc).tools)
    : []))
  const data = Schema.decodeSync(Schema.Struct({ specs: Schema.Array(ToolSpec), names: Schema.Array(Schema.String) }))(structuredClone({ specs: [...methods.map(method => method.spec), ...additional], names: [...registry.keys(), ...additional.map(spec => spec.name)] }))
  return Layer.merge(Layer.succeed(ToolCatalog, { ...data, nativeTools, libraries: implementations.map(value => value.library) }), ExecuteTool.layer(input => {
    if (input.error !== undefined) return Effect.fail(input.error)
    if (input.value !== undefined) return Effect.succeed(input.value)
    const method = registry.get(input.call.name)
    return (method ? method.execute(input.call.input, input.call) : Effect.fail(new RuntimeError(`Unknown tool: ${input.call.name}`))).pipe(
      Effect.map(result => result.type === "promise" ? ExecuteTool.defer(result.handle) : result.value), Effect.mapError(String),
    )
  }, { cancel: (input, context) => registry.get(input.call.name)?.cancel?.(context.handle, input.call) ?? Effect.void })).pipe(Layer.provide(libraryBindings(libraries)))
}

/**
 * toolActs supplies the catalog and execution adapter for explicitly configured libraries.
 * @deprecated Declare libraries in agent tools and supply implementations through the host layer.
 */
export function toolActs<const L extends readonly BindableLibrary[]>(libraries: L, additional: readonly ToolSpec[] = []) {
  return libraryServices(libraries, additional)
}
