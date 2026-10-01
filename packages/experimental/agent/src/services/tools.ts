import { Effect, Layer, Schema } from "effect"
import { RuntimeError } from "@clavia/tardigrade-experimental-core"
import { packageTools, type Package } from "@clavia/tardigrade-experimental-packages"
import { ToolSpec } from "@clavia/tardigrade-experimental-packages/types"
import { ExecuteTool } from "../acts"
import { ToolCatalog } from "../context"

// toolActs supplies a data catalog and an implementation backed by the configured packages.
export function toolActs<const P extends readonly Package<unknown>[]>(packages: P, additional: readonly ToolSpec[] = []) {
  const methods = packageTools(packages)
  const registry = new Map(methods.flatMap(method => [method.spec.name, ...(method.aliases ?? [])].map(name => [name, method] as const)))
  const data = Schema.decodeSync(Schema.Struct({ specs: Schema.Array(ToolSpec), names: Schema.Array(Schema.String) }))(structuredClone({ specs: [...methods.map(method => method.spec), ...additional], names: [...registry.keys(), ...additional.map(spec => spec.name)] }))
  return Layer.merge(Layer.succeed(ToolCatalog, data), ExecuteTool.layer(input => {
    if (input.error !== undefined) return Effect.fail(input.error)
    if (input.value !== undefined) return Effect.succeed(input.value)
    const method = registry.get(input.call.name)
    return (method ? method.execute(input.call.input, input.call) : Effect.fail(new RuntimeError(`Unknown tool: ${input.call.name}`))).pipe(
      Effect.map(result => result.type === "promise" ? ExecuteTool.defer(result.handle) : result.value), Effect.mapError(String),
    )
  }, { cancel: (input, context) => registry.get(input.call.name)?.cancel?.(context.handle, input.call) ?? Effect.void }))
}
