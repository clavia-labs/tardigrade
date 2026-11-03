import { strict as assert } from "node:assert"
import { artifactBytes, publishArtifact, recordChange, type WorkspaceLifecycleDriver } from "../../fixtures/workspace/shared"

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
