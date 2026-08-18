import { Layer } from "effect"
import { jsSandboxService, jsSandboxServiceFor, Sandbox, type SandboxPolicy } from "./sandbox"
import { memoryTmpService, Tmp } from "./tmp"

// The code lane's explicit seam bindings. Both services default to these implementations
// (Sandbox and Tmp are References), so a caller only provides a layer to override, or to get a
// tmp store that is fresh rather than the process-shared default.

export const jsSandbox: Layer.Layer<never> = Layer.succeed(Sandbox)(jsSandboxService)

// jsSandboxFor is the same layer on a stated console cap (sandbox.ts, SandboxPolicy).
export const jsSandboxFor = (policy: Partial<SandboxPolicy>): Layer.Layer<never> =>
  Layer.succeed(Sandbox)(jsSandboxServiceFor(policy))

export const memoryTmp = (): Layer.Layer<never> => Layer.succeed(Tmp)(memoryTmpService())
