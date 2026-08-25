import { Layer } from "effect"
import { jsSandboxService, jsSandboxServiceFor, Sandbox, type SandboxPolicy } from "./service"

// The code lane's explicit sandbox bindings. Sandbox is a Reference and defaults to this
// implementation, so a caller only provides a layer to override it. The spill store has no
// default: a lane names its backend by providing a KeyValueStore layer (spill.ts).

export const jsSandbox: Layer.Layer<never> = Layer.succeed(Sandbox)(jsSandboxService)

// jsSandboxFor is the same layer on a stated console cap (sandbox.ts, SandboxPolicy).
export const jsSandboxFor = (policy: Partial<SandboxPolicy>): Layer.Layer<never> =>
  Layer.succeed(Sandbox)(jsSandboxServiceFor(policy))
