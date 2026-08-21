import { expect, test } from "bun:test"
import type { OutputCapability } from "./output"

// The compile-time half of the capability. `bun run typecheck` fails on an unsatisfied
// `@ts-expect-error` as loudly as on a type error, so a combination that stops being rejected
// breaks the gate. The runtime half is model.test.ts.

const accepts = <T>(_value: T): void => {}

// A capability is a closed union: an endpoint that promises nothing has no tool-combination
// question to answer, and a native one must answer it. Neither half can be left to a default,
// because both are what a turn is refused or served on (src/output.ts, outputModeOf).
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

test("the capability type is asserted over a real union", () => {
  expect(((): OutputCapability => ({ guarantee: "native", withTools: true }))()).toEqual({
    guarantee: "native",
    withTools: true
  })
})
