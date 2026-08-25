import { expect, test } from "bun:test"
import type { Actor } from "@clavia/tardigrade-core/actor"
import {
  actor,
  infer,
  nativeOutput,
  outputRepair,
  type AgentComponent,
  type NativeOutputSupport,
  type OutputFallbackComponent
} from "../index"

const accepts = <T>(_value: T): void => {}
const TEST_MODEL = { provider: "test", default_model: "test-model" } as const

const empty: AgentComponent = {
  name: "empty",
  derive: () => ({
    view: { system: [], tools: [], context: [], output: [] },
    transitions: []
  })
}

const nativeOnly = actor({ name: "native-only", methods: {}, components: [infer([empty, nativeOutput], TEST_MODEL)] })
const repaired = actor({ name: "repaired", methods: {}, components: [infer([empty, outputRepair], TEST_MODEL)] })

type Requirements<A> = A extends Actor<infer R> ? R : never
type RequiresNative<A> = NativeOutputSupport extends Requirements<A> ? true : false

// outputRequirements proves that the component tuple changes the host's Effect environment.
export const outputRequirements = (): void => {
  accepts<RequiresNative<typeof nativeOnly>>(true)
  accepts<RequiresNative<typeof repaired>>(false)
}

// fallbackBrand proves that only defineOutputFallback and the built-in fallback constructors can mark a fallback strategy.
export const fallbackBrand = (): void => {
  // @ts-expect-error a plain component has not been checked as an always-present output fallback
  accepts<OutputFallbackComponent>(empty)
}

test("output strategy components carry their requirements without changing the runtime shape", () => {
  expect(nativeOnly.reactors).toHaveLength(repaired.reactors.length)
})
