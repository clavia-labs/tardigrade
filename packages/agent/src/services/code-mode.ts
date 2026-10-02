import { isDeepStrictEqual } from "node:util"
import { Cause, Clock, Effect, Exit, Layer, Schema } from "effect"
import { atom, durablePromise, EffectExecution, effectKey, Isolate, RuntimeError } from "@clavia/tardigrade-core"
import { ToolCatalog } from "../actor/context"
import { type AgentTool, type LibraryImplementation, type LibraryRequirements } from "@clavia/tardigrade-libraries"
import { codeModeSpec } from "../contracts/libraries"
import { CodeCalled, EvaluateCode, ExecutePackage, PackageCalled } from "../contracts/code-mode"
import { executions } from "../atoms/durable/code-mode"

// codeModeActs supplies tool descriptions, isolate RPC, and independently durable library execution.
export function codeModeActs<const L extends readonly LibraryImplementation<unknown>[]>(implementations: L, options: { readonly signatureDepth?: number } = {}) {
  type R = LibraryRequirements<L[number]>
  if (new Set(implementations.map(pkg => pkg.library.name)).size !== implementations.length) throw new Error("Duplicate library name")
  const libraries = implementations.map(value => value.library)
  const spec = codeModeSpec(libraries, options.signatureDepth)
  const catalog = Layer.succeed(ToolCatalog, { names: ["execute"], specs: [spec], libraries })
  const registry = new Map(implementations.flatMap(pkg => (pkg.methods as readonly AgentTool<R>[]).map(method => [JSON.stringify([pkg.library.name, method.spec.name]), method] as const)))
  const executePackage = ExecutePackage.layer((input, { ref }) => Effect.gen(function* () {
    const method = registry.get(JSON.stringify([input.package, input.method]))
    if (!method) return yield* Effect.fail(new RuntimeError(`Unknown library method: ${input.package}.${input.method}`))
    const result = yield* method.execute(input.input, { callId: effectKey(ref), parentCallId: input.callId, name: input.method, input: input.input })
    if (result.type !== "value") return yield* Effect.fail(new RuntimeError("Code mode cannot await background library results"))
    return result.value
  }).pipe(Effect.mapError(String)))
  const evaluateCode = EvaluateCode.layer(input => Effect.gen(function* () {
    const configured = input.libraries === undefined ? implementations : input.libraries.map(name => {
      const library = implementations.find(value => value.library.name === name)
      if (!library) throw new RuntimeError(`Library is not configured in host services: ${name}`)
      return library
    })
    if (input.libraries && new Set(input.libraries).size !== input.libraries.length) return yield* Effect.fail("Duplicate library name")
    const execution = yield* EffectExecution
    const isolate = yield* Isolate
    const reply = durablePromise(execution.ref, { success: Schema.Json, error: Schema.String })
    const entry = atom(get => get(executions).find(entry => entry.call.callId === input.callId && entry.codeMode === input.codeMode))
    const run = Effect.gen(function* () {
      const initial = execution.get(entry)
      if (!initial) return yield* Effect.fail("No accepted code execution")
      const ambient = initial.ambient ?? { at: yield* Clock.currentTimeMillis, seed: effectKey(execution.ref) }
      if (!initial.ambient) yield* execution.record({ type: "CodeCalled", codeMode: input.codeMode, callId: input.callId, ambient } satisfies typeof CodeCalled.Type)
      const seen = new Set<number>()
      let drift: string | undefined
      const outcome = yield* isolate.run({ code: input.code, ambient, packages: Object.fromEntries(configured.map(pkg => [pkg.library.name, pkg.methods.map(method => method.spec.name)])) }, call => Effect.gen(function* () {
        if (!configured.some(library => library.library.name === call.package)) return yield* Effect.fail(`Library is not selected for this execution: ${call.package}`)
        const recorded = execution.get(entry)?.calls.find(value => value.ordinal === call.ordinal)
        seen.add(call.ordinal)
        if (recorded && (recorded.package !== call.package || recorded.method !== call.method || !isDeepStrictEqual(recorded.input, call.input))) {
          drift = `Nondeterministic code mode: library call ${call.ordinal} differs from its recorded method or arguments`
          return yield* Effect.fail(drift)
        }
        if (!recorded) yield* execution.record({ type: "PackageCalled", codeMode: input.codeMode, callId: input.callId, ...call } satisfies typeof PackageCalled.Type)
        const result = yield* execution.waitFor(atom(get => get(entry)?.calls.find(value => value.ordinal === call.ordinal)?.outcome ?? undefined)).pipe(Effect.mapError(String))
        return result.status === "fulfilled" ? result.value : yield* Effect.fail(result.reason)
      }).pipe(Effect.mapError(String))).pipe(Effect.exit)
      const completed = yield* execution.waitFor(atom(get => {
        const current = get(entry)
        return current && current.calls.every(call => call.outcome !== null) ? current : undefined
      })).pipe(Effect.mapError(String))
      if (drift) return yield* Effect.fail(drift)
      if (seen.size !== completed.calls.length) return yield* Effect.fail("Nondeterministic code mode: replay omitted recorded library calls")
      if (Exit.isFailure(outcome)) return yield* Effect.fail(Cause.pretty(outcome.cause))
      return yield* Schema.decodeUnknownEffect(Schema.Json)(outcome.value).pipe(Effect.mapError(String))
    }).pipe(Effect.exit, Effect.map(exit => Exit.isSuccess(exit) ? reply.succeed(exit.value) : reply.fail(Cause.pretty(exit.cause))))
    return EvaluateCode.defer(yield* execution.fork(run))
  }).pipe(Effect.mapError(String)), { cancel: (input, context) => Effect.gen(function* () {
    const owned = context.get(executions).find(entry => entry.call.callId === input.callId && entry.codeMode === input.codeMode)
    for (const call of owned?.calls ?? []) if (call.ref && call.outcome === null) yield* context.cancel(call.ref, context.reason)
  }) })
  return Layer.mergeAll(catalog, evaluateCode, executePackage)
}
