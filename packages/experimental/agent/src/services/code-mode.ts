import { isDeepStrictEqual } from "node:util"
import { Cause, Clock, Effect, Exit, Layer, Schema } from "effect"
import { atom, durablePromise, EffectExecution, effectKey, Isolate, RuntimeError } from "@clavia/tardigrade-experimental-core"
import { ToolCatalog } from "../context"
import { type AgentTool, type Package, type PackageRequirements } from "@clavia/tardigrade-experimental-packages"
import { renderSignature } from "@clavia/tardigrade-code/execution/contract"
import { CodeCalled, EvaluateCode, ExecutePackage, PackageCalled } from "../code-mode/contracts"

import { executions } from "../code-mode/projections"

// codeModeActs supplies tool descriptions, isolate RPC, and independently durable package execution.
export function codeModeActs<const P extends readonly Package<unknown>[]>(packages: P, options: { readonly signatureDepth?: number } = {}) {
  type R = PackageRequirements<P[number]>
  if (new Set(packages.map(pkg => pkg.name)).size !== packages.length) throw new Error("Duplicate package name")
  for (const pkg of packages) {
    if (["console", "Date", "Math"].includes(pkg.name)) throw new Error(`Reserved code binding: ${pkg.name}`)
    for (const method of pkg.methods) {
      if (method.spec.execution === "async") throw new Error(`Code mode requires sync methods: ${pkg.name}.${method.spec.name}`)
    }
  }
  const description = [
    "Run an async JavaScript body against the connected packages. Await package methods and end with return <value>. The result includes console logs. Package calls must occur in the same order with the same arguments during replay.",
    ...packages.map(pkg => [`${pkg.name}: ${pkg.description}`, ...pkg.methods.map(method =>
      `  ${pkg.name}.${renderSignature(method.spec.name, method.spec.inputSchema, options.signatureDepth)} -> unknown: ${method.spec.description}`)].join("\n")),
  ].join("\n")
  const catalog = Layer.succeed(ToolCatalog, {
    names: ["execute"], specs: [{ name: "execute", description, inputSchema: {
      type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false,
    } }],
  })
  const registry = new Map(packages.flatMap(pkg => (pkg.methods as readonly AgentTool<R>[]).map(method => [JSON.stringify([pkg.name, method.spec.name]), method] as const)))
  const executePackage = ExecutePackage.layer((input, { ref }) => Effect.gen(function* () {
    const method = registry.get(JSON.stringify([input.package, input.method]))
    if (!method) return yield* Effect.fail(new RuntimeError(`Unknown package method: ${input.package}.${input.method}`))
    const result = yield* method.execute(input.input, { callId: effectKey(ref), parentCallId: input.callId, name: input.method, input: input.input })
    if (result.type !== "value") return yield* Effect.fail(new RuntimeError("Code mode cannot await deferred package results"))
    return result.value
  }).pipe(Effect.mapError(String)))
  const evaluateCode = EvaluateCode.layer(input => Effect.gen(function* () {
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
      const outcome = yield* isolate.run({ code: input.code, ambient, packages: Object.fromEntries(packages.map(pkg => [pkg.name, pkg.methods.map(method => method.spec.name)])) }, call => Effect.gen(function* () {
        const recorded = execution.get(entry)?.calls.find(value => value.ordinal === call.ordinal)
        seen.add(call.ordinal)
        if (recorded && (recorded.package !== call.package || recorded.method !== call.method || !isDeepStrictEqual(recorded.input, call.input))) {
          drift = `Nondeterministic code mode: package call ${call.ordinal} differs from its recorded method or arguments`
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
      if (seen.size !== completed.calls.length) return yield* Effect.fail("Nondeterministic code mode: replay omitted recorded package calls")
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
