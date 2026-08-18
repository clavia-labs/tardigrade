import { Layer } from "effect"
import { jsSandboxService, Sandbox } from "./sandbox"
import { memoryTmpService, Tmp } from "./tmp"

// The code lane's explicit seam bindings. Both services default to these implementations
// (Sandbox and Tmp are References), so a caller only provides a layer to override, or to get a
// tmp store that is fresh rather than the process-shared default.

export { LOG_CAP_BYTES } from "./sandbox"

export const jsSandbox: Layer.Layer<never> = Layer.succeed(Sandbox)(jsSandboxService)

export const memoryTmp = (): Layer.Layer<never> => Layer.succeed(Tmp)(memoryTmpService())
