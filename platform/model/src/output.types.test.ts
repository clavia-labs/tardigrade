import { expect, test } from "bun:test"
import type { Layer } from "effect"
import type { NativeOutputSupport } from "tardie"
import { infer } from "./model"
import type { OutputCapability } from "./output"

// The compile-time half of the capability. `bun run typecheck` fails on an unsatisfied
// `@ts-expect-error` as loudly as on a type error, so a combination that stops being rejected
// breaks the gate. The runtime half is model.test.ts.

const accepts = <T>(_value: T): void => {}

// A capability is a closed union: an endpoint that promises nothing has no tool-combination
// question to answer, and a native one must answer it. Neither half can be left to a default,
// because both are what a turn is refused or served on (src/output/contract.ts, outputModeOf).
export const capabilities = (): void => {
  accepts<OutputCapability>({ guarantee: "none" })
  accepts<OutputCapability>({ guarantee: "native", withTools: true })
  accepts<OutputCapability>({ guarantee: "native", withTools: false })
  // @ts-expect-error a native guarantee states whether it survives beside a tool list
  accepts<OutputCapability>({ guarantee: "native" })
  // @ts-expect-error an endpoint that promises nothing has no tool combination to describe
  accepts<OutputCapability>({ guarantee: "none", withTools: true })
  // @ts-expect-error there is no third guarantee, and no checked variant of the native one
  accepts<OutputCapability>({ guarantee: "native-checked", withTools: true })
}

const native = infer({
  baseUrl: "https://model.test",
  apiKey: "test",
  model: "strict",
  provider: "test",
  contextWindowTokens: 128_000,
  protocol: "openai-responses",
  output: { guarantee: "native", withTools: true }
})

const toolLimited = infer({
  baseUrl: "https://model.test",
  apiKey: "test",
  model: "strict-without-tools",
  provider: "test",
  contextWindowTokens: 128_000,
  protocol: "openai-responses",
  output: { guarantee: "native", withTools: false }
})

const unproven = infer({
  baseUrl: "https://model.test",
  apiKey: "test",
  model: "unproven",
  provider: "test",
  contextWindowTokens: 128_000,
  protocol: "openai-responses",
  output: { guarantee: "none" }
})

type Provided<L> = L extends Layer.Layer<infer A, unknown, unknown> ? A : never
type ProvidesNative<L> = NativeOutputSupport extends Provided<L> ? true : false

// nativeEvidence proves that infer supplies native DI evidence only for a statically known capability that includes tools.
export const nativeEvidence = (): void => {
  accepts<ProvidesNative<typeof native>>(true)
  accepts<ProvidesNative<typeof toolLimited>>(false)
  accepts<ProvidesNative<typeof unproven>>(false)
}

test("the capability type is asserted over a real union", () => {
  expect(((): OutputCapability => ({ guarantee: "native", withTools: true }))()).toEqual({
    guarantee: "native",
    withTools: true
  })
})
