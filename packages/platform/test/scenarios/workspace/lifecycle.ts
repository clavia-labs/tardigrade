import { strict as assert } from "node:assert"
import { artifactBytes, publishArtifact, recordChange, type WorkspaceLifecycleDriver, type WorkspaceScenarioDriver } from "../../fixtures/workspace/shared"

// workspaceLifecycle checks artifact persistence and mutation replay across a reply-losing host restart.
export async function workspaceLifecycle(driver: WorkspaceLifecycleDriver) {
  // The agent writes an artifact and retains its object-store reference.
  await driver.bash(publishArtifact, "publish")
  const artifact = await driver.read("artifact.png")
  assert.ok(typeof artifact !== "string" && "object" in artifact, "binary reads must return a stored file")
  assert.equal(artifact.mediaType, "image/png")
  assert.equal(artifact.byteSize, artifactBytes.byteLength)
  assert.deepEqual(await driver.resolve(artifact.object), artifactBytes)

  // The next mutation saves its outcome, but the host dies before delivering its reply.
  await driver.loseReply(recordChange, "record")
  await driver.restart()

  // The new host replays one change and resolves the original reference before reading the file again.
  assert.equal(await driver.bash(recordChange, "record"), "recorded\n")
  assert.equal(await driver.read("changes.txt"), "recorded\n")
  assert.deepEqual(await driver.resolve(artifact.object), artifactBytes)
  const reread = await driver.read("artifact.png")
  assert.ok(typeof reread !== "string" && "object" in reread)
  assert.deepEqual(reread.object, artifact.object)
}

const failure = (error: unknown, expected: RegExp) => {
  assert.ok(error instanceof Error && error.cause instanceof Error)
  assert.match(error.cause.message, expected)
  return true
}

const rejects = (run: () => Promise<unknown>, expected: RegExp) => assert.rejects(run, error => failure(error, expected))

const duplicates = async (run: () => Promise<unknown>, expected?: string) => {
  const outcomes = await Promise.allSettled(Array.from({ length: 3 }, run))
  assert.ok(outcomes.some(outcome => outcome.status === "fulfilled"))
  for (const outcome of outcomes) {
    if (outcome.status === "fulfilled") assert.equal(outcome.value, expected)
    else failure(outcome.reason, /re-execution is blocked/)
  }
}

const crash = async (driver: WorkspaceScenarioDriver, fault: "afterClaim" | "beforeComplete") => {
  await driver.interrupt(recordChange, "record", fault)
  await driver.restart()
  await rejects(() => driver.bash(recordChange, "record"), /re-execution is blocked/)
  assert.equal(await driver.bash("if [ -f changes.txt ]; then cat changes.txt; fi", "inspect"), fault === "afterClaim" ? "" : "recorded\n")
}

const concurrentReplay = async (driver: WorkspaceScenarioDriver) => {
  await duplicates(() => driver.bash(recordChange, "record"), "recorded\n")
  await driver.restart()
  assert.equal(await driver.bash(recordChange, "record"), "recorded\n")
  await rejects(() => driver.bash("printf different >> changes.txt", "record"), /different workspace inputs/)
  assert.equal(await driver.read("changes.txt"), "recorded\n")
}

const fileReplay = async (driver: WorkspaceScenarioDriver) => {
  await rejects(() => driver.write("../outside.txt", "invalid", "write"), /outside|contained/)
  await driver.write("file.txt", "start:fixture", "write")
  await rejects(() => driver.edit("file.txt", "missing-token", "wrong", "failure"), /Expected oldText exactly once/)
  await duplicates(() => driver.edit("file.txt", "start:", "end:", "edit"))
  await driver.restart()
  await driver.write("file.txt", "start:fixture", "write")
  await driver.edit("file.txt", "start:", "end:", "edit")
  assert.equal(await driver.read("file.txt"), "end:fixture")
  await driver.write("file.txt", "missing-token", "repair")
  await rejects(() => driver.edit("file.txt", "missing-token", "wrong", "failure"), /Expected oldText exactly once/)
  await rejects(() => driver.write("file.txt", "different operation", "edit"), /different workspace inputs/)
  assert.equal(await driver.read("file.txt"), "missing-token")
}

export const workspaceScenarios: ReadonlyArray<{ readonly name: string; readonly run: (driver: WorkspaceScenarioDriver) => Promise<void> }> = [
  { name: "an artifact and one keyed change survive a lost reply and restart", run: workspaceLifecycle },
  { name: "a crash after claim blocks replay without executing the mutation", run: driver => crash(driver, "afterClaim") },
  { name: "a crash after mutation blocks replay without executing twice", run: driver => crash(driver, "beforeComplete") },
  { name: "concurrent duplicates execute once and conflicting inputs are rejected", run: concurrentReplay },
  { name: "saved write and edit outcomes survive restart and later file changes", run: fileReplay },
]
