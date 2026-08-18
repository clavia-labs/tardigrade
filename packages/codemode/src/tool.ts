import { Effect, Schema } from "effect"
import { sumUsage, usageOf, ZERO_USAGE, type NativeTool, type NativeToolContext, type Usage } from "@flamecast/harness/infer"
import { tool } from "@flamecast/harness/tool"
import {
  surfaceOf,
  type Capability,
  type CapabilityContext,
  type CapabilitySurface
} from "./capability"
import { Sandbox } from "./sandbox"

// Code mode: the model writes a script, and the script drives the capabilities the harness offers.
// One model call can then do what a chain of tool calls would do, and the intermediate values stay
// inside the sandbox rather than passing through the context window.
//
// This is an ordinary native tool. Dispatch, the budget wall, dedup, and replay come from the
// machinery that already serves every other tool: `ToolCalled` records the source, `ToolReturned`
// records the outcome, and a settle that finds a committed `ToolReturned` never runs the script
// again. Nothing here needs its own event type, because a script's own effects are recorded where
// they land. A sub-agent call records the crossing in the child's log through `origin`, so the
// delegation tree is still derived rather than carried.

export interface CodemodeOptions<R = never> {
  readonly capabilities: ReadonlyArray<Capability<R>>
  readonly name?: string
  readonly description?: string
  // The ceiling on capability calls in one script. A script is one tool call at the budget wall, so
  // this is what keeps a single call from spending without bound.
  readonly maxCalls?: number
  readonly timeoutMs?: number
}

export interface CodemodeResult {
  readonly value?: unknown
  readonly output: ReadonlyArray<string>
  readonly error?: string
  // What the script reached, in call order. The trace of one script, without the values.
  readonly calls: ReadonlyArray<string>
  // What the script spent through its capabilities. A script is one call at the budget wall, so
  // this is what keeps the turn's tree cost honest about the work that happened inside it.
  readonly usage: Usage
}

const DEFAULT_MAX_CALLS = 64

const SOURCE_INPUT = Schema.Struct({
  source: Schema.String.annotate({ description: "The body of an async JavaScript function." })
})

const describe = (capabilities: ReadonlyArray<CapabilitySurface>, extra?: string) =>
  [
    "Run JavaScript. The body is an async function, so it can await and return.",
    "Return the value the caller needs, and use print(...) for progress.",
    "Prefer one script that gathers everything over many separate calls, and use Promise.all for independent work.",
    extra,
    "",
    "Available:",
    surfaceOf(capabilities)
  ]
    .filter((part) => part !== undefined)
    .join("\n")

export const codemode = <R = never>(
  options: CodemodeOptions<R>
): NativeTool<R | Sandbox> => {
  const names = new Set<string>()
  for (const one of options.capabilities) {
    if (names.has(one.name)) throw new Error(`capability "${one.name}" is offered more than once`)
    names.add(one.name)
  }
  const maxCalls = options.maxCalls ?? DEFAULT_MAX_CALLS
  return tool({
    name: options.name ?? "execute",
    description: options.description ?? describe(options.capabilities),
    input: SOURCE_INPUT,
    run: (input, context) =>
      Effect.gen(function* () {
        const source = input.source
        if (source.trim() === "") {
          return {
            output: [],
            calls: [],
            usage: ZERO_USAGE,
            error: "no source to run"
          } satisfies CodemodeResult
        }
        const execId = execIdOf(context)
        const services = yield* Effect.context<R>()
        const calls: Array<string> = []
        const spend: Array<Usage> = []
        // The call index is the script's own evaluation order, so a re-run of the same source mints
        // the same ids and a receiver that dedups absorbs the repeat.
        let sequence = 0
        const api = Object.fromEntries(
          options.capabilities.map((one) => [
            one.name,
            Object.fromEntries(
              one.methods.map((method) => [
                method.name,
                (...args: ReadonlyArray<unknown>) => {
                  const label = `${one.name}.${method.name}`
                  if (calls.length >= maxCalls) {
                    return Promise.reject(
                      new Error(`the script reached its ceiling of ${maxCalls} capability calls`)
                    )
                  }
                  calls.push(label)
                  const at: CapabilityContext = {
                    turn: context?.turn ?? "",
                    execId,
                    sequence: sequence++
                  }
                  // A capability that reached a model reports what it spent, and the script's
                  // result carries the sum, so spend inside a sandbox still folds up the tree.
                  return Effect.runPromiseWith(services)(method.run(args, at)).then((value) => {
                    const reported = (value as { readonly usage?: unknown } | undefined)?.usage
                    if (reported !== undefined) spend.push(usageOf(reported))
                    return value
                  })
                }
              ])
            )
          ])
        )
        const outcome = yield* Effect.flatMap(Sandbox, (sandbox) =>
          sandbox.run({
            source,
            api,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
          })
        )
        return {
          ...(outcome.value === undefined ? {} : { value: outcome.value }),
          output: outcome.output,
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
          calls,
          usage: spend.reduce(
            (total, one) => sumUsage([total, one]),
            ZERO_USAGE
          )
        } satisfies CodemodeResult
      })
  })
}

// The script's identity inside its turn. It names the provider call that asked, so two scripts in
// one turn mint different ids and a redispatch of one script mints the id it minted before.
const execIdOf = (context: NativeToolContext | undefined) =>
  context === undefined ? "exec" : `${context.turn}/${context.callId}`
