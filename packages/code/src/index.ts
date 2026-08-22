// The package root exposes code components, the code reactor, and its event keys. Agent
// assemblies adapt code components through codeMode in packages/agent/src/components/code.ts.
export { codeReactor } from "./execute"
export { codeKeys } from "./events"
export {
  CODE_VIEW_ALGEBRA,
  definePackage,
  type CodeComponent,
  type CodeView,
  type Package,
  type PackageDefinition,
  type PackageRequirements
} from "./packages"
