import { Effect, Fiber, Layer, Schema, Scope } from "effect"
import { Isolate, type IsolateCall, type IsolateInput, type IsolateResult } from "@clavia/tardigrade-experimental-core/services/isolate"
import { bunSandboxServiceFor, type BunSandboxPolicy } from "@clavia/tardigrade-bun/sandbox"
import { sandboxReturned, type SandboxCall } from "@clavia/tardigrade-code/sandbox/service"

export { DEFAULT_BUN_SANDBOX_POLICY as DEFAULT_ISOLATE_POLICY } from "@clavia/tardigrade-bun/sandbox"
export type IsolatePolicy = BunSandboxPolicy

// bunIsolate runs each code body in a Bun subprocess and routes package calls through its scoped RPC handler.
export function bunIsolate(policy: Partial<IsolatePolicy> = {}) {
  const sandbox = bunSandboxServiceFor(policy)
  const run = <Services>(input: IsolateInput, onCall: (call: IsolateCall) => Effect.Effect<Schema.Json, string, Services>): Effect.Effect<IsolateResult, string, Services> => Effect.scoped(Effect.gen(function* () {
    const context = yield* Effect.context<Services>()
    const scope = yield* Scope.Scope
    let accepting = true
    yield* Effect.addFinalizer(() => Effect.sync(() => { accepting = false }))
    const bindings: Record<string, Record<string, SandboxCall>> = {}
    for (const [name, methods] of Object.entries(input.packages)) {
      if (["console", "Date", "Math"].includes(name)) return yield* Effect.fail(`Reserved isolate binding: ${name}`)
      bindings[name] = Object.fromEntries(methods.map(method => [method, (args: unknown, ordinal: number) => Effect.runPromiseWith(context)(Effect.gen(function* () {
        if (!accepting) return yield* Effect.fail("Isolate execution is closed")
        const value = yield* Schema.decodeUnknownEffect(Schema.Json)(structuredClone(args ?? {})).pipe(Effect.mapError(String))
        const result = yield* onCall({ ordinal, package: name, method, input: value })
        const encoded = yield* Schema.decodeEffect(Schema.Json)(structuredClone(result)).pipe(Effect.mapError(String))
        return sandboxReturned(encoded)
      }).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)))]))
    }
    const outcome = yield* sandbox.run(input.code, bindings, input.ambient)
    accepting = false
    const result = yield* Schema.decodeUnknownEffect(Schema.Json)(outcome.result ?? null).pipe(Effect.mapError(String))
    return { result, logs: outcome.logs ?? [], ...(outcome.error === undefined ? {} : { error: outcome.error }) }
  }))
  return Layer.succeed(Isolate, { run })
}
