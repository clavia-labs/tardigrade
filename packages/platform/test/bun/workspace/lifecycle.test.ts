import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient, SqlError } from "effect/sql"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { WorkspaceBackend, WorkspaceError } from "@clavia/tardigrade-libraries/workspace/index"
import { virtualWorkspace } from "../../../src/shared/workspace/virtual/index"
import { bunWorkspaceLifecycle } from "../../fixtures/workspace/bun"
import { workspaceScenarios } from "../../scenarios/workspace/lifecycle"
import { WORKSPACE_SCENARIO_TIMEOUT_MS } from "../../fixtures/workspace/shared"

test.each([...workspaceScenarios])("$name", async scenario => {
  const driver = await bunWorkspaceLifecycle()
  try { await scenario.run(driver) } finally { await driver.close() }
}, WORKSPACE_SCENARIO_TIMEOUT_MS)

test("virtual workspace reports storage failures and resumes writes after storage recovers", async () => {
  const runtime = ManagedRuntime.make(virtualWorkspace({ name: "storage-errors", network: { mode: "none" } }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
  ))
  try {
    const workspace = await runtime.runPromise(WorkspaceBackend)
    await runtime.runPromise(workspace.write("report.txt", "original"))
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`PRAGMA query_only = ON`))
    const error = await runtime.runPromise(workspace.write("report.txt", "changed").pipe(Effect.flip))
    expect(error).toBeInstanceOf(WorkspaceError)
    expect(error.message).toContain("Workspace storage failed")
    expect(SqlError.isSqlError(error.cause)).toBe(true)
    await runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql => sql`PRAGMA query_only = OFF`))
    expect(await runtime.runPromise(workspace.read("report.txt"))).toBe("original")
    await runtime.runPromise(workspace.write("report.txt", "recovered"))
    expect(await runtime.runPromise(workspace.read("report.txt"))).toBe("recovered")
  } finally { await runtime.dispose() }
})
