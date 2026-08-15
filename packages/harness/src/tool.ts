import { Effect, Result, Schema } from "effect"
import type { NativeTool, NativeToolContext } from "./infer"
import { jsonSchemaOf } from "./schema"

// A tool whose schema and handler are one declaration. The input the handler receives is the type
// its own schema describes, so a field the schema does not offer is a compile error rather than an
// `undefined` the handler reads at runtime.
//
// Arguments are decoded before the handler runs. A model can produce a well-formed call whose
// arguments miss the schema, and a handler typed against that schema would then be reading a lie.
// The handler receives the decoded value, so what it reads is what the schema promised, and a
// mismatch returns to the model as an ordinary tool error it can repair.

export interface ToolOptions<S extends Schema.ConstraintDecoder<unknown, never>, R> {
  readonly name: string
  readonly description: string
  readonly input: S
  readonly run: (input: S["Type"], context?: NativeToolContext) => Effect.Effect<unknown, never, R>
}

export const tool = <S extends Schema.ConstraintDecoder<unknown, never>, R = never>(
  options: ToolOptions<S, R>
): NativeTool<R> => {
  const decode = Schema.decodeUnknownResult(options.input, {
    errors: "all",
    onExcessProperty: "error"
  })
  return {
    spec: {
      name: options.name,
      description: options.description,
      inputSchema: jsonSchemaOf(options.input)
    },
    run: (input, context) =>
      Effect.suspend(() => {
        const decoded = decode(input === undefined ? {} : input)
        if (Result.isFailure(decoded)) {
          return Effect.succeed({
            error: `the arguments did not match this tool's schema: ${decoded.failure.message}`
          })
        }
        return options.run(decoded.success, context)
      })
  }
}
