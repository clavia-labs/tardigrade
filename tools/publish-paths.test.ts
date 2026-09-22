import { expect, test } from "bun:test"
import { rewriteComponentRuntimeImports } from "./publish-paths"

test("private runtime imports resolve inside the assembled package", () => {
  expect(rewriteComponentRuntimeImports('import { machineOf } from "../../../../core/src/component/runtime"',
    "/stage/src/agent/component/budget/index.ts", "/stage/src"))
    .toBe('import { machineOf } from "../../../core/component/runtime"')
  expect(rewriteComponentRuntimeImports("import { registerComponent } from '../../../core/src/component/runtime'",
    "/stage/src/code/package/definition.ts", "/stage/src"))
    .toBe("import { registerComponent } from '../../core/component/runtime'")
  const withinCore = 'import { machineOf } from "./runtime"'
  expect(rewriteComponentRuntimeImports(withinCore, "/stage/src/core/component/machine.ts", "/stage/src")).toBe(withinCore)
})
