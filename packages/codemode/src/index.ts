// The public surface of @flamecast/codemode. This is the one file in the package that re-exports:
// a library owes its consumers one door. Inside the package, a module imports from the file that
// defines the symbol.

export {
  capability,
  surfaceOf,
  type Capability,
  type CapabilityContext,
  type CapabilityMethod
} from "./capability"
export { codemode, type CodemodeOptions, type CodemodeResult } from "./tool"
export {
  Sandbox,
  inProcessSandbox,
  type SandboxOutcome,
  type SandboxRequest
} from "./sandbox"
export { agents, type AgentsOptions } from "./capabilities/agents"
