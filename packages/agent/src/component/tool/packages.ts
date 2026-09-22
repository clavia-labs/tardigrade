import { component, composeComponents, type ComponentRequirements } from "@clavia/tardigrade-core/actor"
import { composeKeys } from "@clavia/tardigrade-core/log"
import type { KeyValueStore } from "effect/unstable/persistence"
import { CODE_VIEW_ALGEBRA, type CodeComponent } from "@clavia/tardigrade-code/package/definition"
import { codeKeys, packageCalled, packageKeyOf } from "@clavia/tardigrade-code/execution/events"
import { packageCallPolicyOf, type CodePolicy } from "@clavia/tardigrade-code/execution/policy"
import { spillPolicyOf, BARE_SPILL_NOTE } from "@clavia/tardigrade-code/storage/store"
import { turnHead } from "@clavia/tardigrade-code/execution/turns"
import { toolComponent, toolConcurrencyOf, type ToolComponent, type ToolConcurrency } from "./machine"
import type { ToolOffer } from "../view"

export interface ToolsOptions {
  readonly name?: (namespace: string, method: string) => string
  readonly concurrency?: ToolConcurrency
  readonly policy?: Partial<CodePolicy>
}

// tools exposes child methods as native model tools while preserving child governance (integration/package-permissions.test.ts).
export const tools = <const Cs extends ReadonlyArray<CodeComponent<unknown>>>(
  children: Cs,
  options: ToolsOptions = {}
): ToolComponent<ComponentRequirements<Cs[number]> | KeyValueStore.KeyValueStore> => {
  const scope = composeComponents("tools.scope", CODE_VIEW_ALGEBRA, children)
  const concurrency = toolConcurrencyOf(options.concurrency)
  const callPolicy = packageCallPolicyOf(options.policy?.call)
  const spill = spillPolicyOf({ note: BARE_SPILL_NOTE, ...options.policy?.spill })
  const adapted = component({
    name: "tools",
    children: scope,
    initial: () => undefined,
    step: state => state,

    output: (_state, child) => {
      const output = child.output()
      const offers = output.view.packages.flatMap(pkg => pkg.methods.map((method): ToolOffer => ({
        spec: { name: options.name?.(pkg.name, method) ?? `${pkg.name}_${method}`, description: pkg.docs?.[method]?.description ?? pkg.description, inputSchema: pkg.docs?.[method]?.input ?? { type: "object", additionalProperties: true } },
        concurrency,
        serve: (call, log, answer) => {
          const request = call.context.intent("dispatch", at => packageCalled({
            callId: request.key, name: `${pkg.name}.${method}`, arguments: call.arguments,
            policy: { call: callPolicy, spill: { spillBytes: spill.spillBytes, previewChars: spill.previewChars, note: spill.note(request.key) }, shadow: turnHead(log)?.shadow === true },
            ...(call.turn === undefined ? {} : { turn: call.turn, epoch: call.epoch ?? 0 }), at
          }), call.turn === undefined ? {} : { invocation: { method: "message", id: call.turn, epoch: call.epoch ?? 0 } })
          const sent = log.find(event => event.type === "PackageCalled" && call.context.matches("dispatch", event))
          if (sent === undefined)
            return [request]
          const returned = log.find(event => event.type === "PackageReturned" && packageKeyOf(event) === packageKeyOf(sent))
          if (returned === undefined)
            return []
          const result = returned.tmp === undefined ? returned.result : { tmp: returned.tmp, size: returned.size, preview: returned.preview, note: returned.note }
          return [answer({ result })]
        }
      })))
      return {
        view: { system: [], tools: offers.map(({ spec, concurrency }) => ({ spec, ...(concurrency === undefined ? {} : { concurrency }) })), context: [], output: [] },
        transitions: output.transitions,
        interactions: {
          tools: () => offers,
          cancel: (cancellation) => child.output().interactions?.cancel?.(cancellation) ?? []
        }
      }
    }
  })
  const fragments = [codeKeys, ...(scope.keys === undefined ? [] : [scope.keys])]
  return toolComponent({ ...adapted, keys: { prefixes: fragments.flatMap(fragment => fragment.prefixes), keyOf: composeKeys(...fragments) } })
}
