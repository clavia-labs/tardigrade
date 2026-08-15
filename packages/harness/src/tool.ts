import { Effect } from "effect"
import type { NativeTool, NativeToolContext } from "./infer"
import { answerErrors } from "./schema"
import type { Spec } from "./spec"

// A tool whose schema and handler are one declaration. The input type the handler receives is the
// type its own schema describes, so a field the schema does not offer is a compile error rather
// than an `undefined` the handler reads at runtime.
//
// Arguments are checked before the handler runs. A model can produce a well-formed call whose
// arguments miss the schema, and a handler typed against that schema would then be reading a lie.
// The check is the one `answerErrors` already performs for the answer tool, so a tool and an
// answer hold their arguments to the same standard, and a mismatch returns to the model as an
// ordinary tool error it can repair.

export interface ToolOptions<Value, R> {
  readonly name: string
  readonly description: string
  readonly input: Spec<Value>
  readonly run: (input: Value, context?: NativeToolContext) => Effect.Effect<unknown, never, R>
}

export const tool = <Value, R = never>(options: ToolOptions<Value, R>): NativeTool<R> => ({
  spec: {
    name: options.name,
    description: options.description,
    inputSchema: options.input.json
  },
  run: (input, context) =>
    Effect.suspend(() => {
      const errors = answerErrors(options.input.json, input)
      if (errors.length > 0) {
        return Effect.succeed({
          error: `the arguments did not match this tool's schema: ${errors.join("; ")}`
        })
      }
      return options.run(input as Value, context)
    })
})
