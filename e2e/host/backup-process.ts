import { BunServices } from "@effect/platform-bun"
import { KeyValueStore } from "effect/unstable/persistence"
import { join } from "node:path"
import { Layer, Schedule } from "effect"
import { defineActor } from "tardie/core"
import { createBunHost, remoteBackupFromKeyValueStore, restoreHostCheckpoint } from "tardie/bun"

const [mode, directory] = Bun.argv.slice(2)
if (mode === undefined || directory === undefined) throw new Error("mode and directory are required")

const actor = defineActor("backup-e2e", {}, [])
const storage = join(directory, "local")
const remote = join(directory, "remote")
const layer = remoteBackupFromKeyValueStore(actor.name).pipe(
  Layer.provide(KeyValueStore.layerFileSystem(remote).pipe(Layer.provide(BunServices.layer)))
)

if (mode === "seed") {
  const host = await createBunHost({ actor, storage, backup: { layer, schedule: Schedule.spaced("10 millis") } })
  try {
    await host.allocateRootThread({ instance: "one", name: "main" })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const status = host.backup?.status()
      if (status?.lastCompleted !== undefined && !status.dirty) {
        console.log(status.lastCompleted.id)
        break
      }
      await Bun.sleep(10)
    }
    if (host.backup?.status().dirty || host.backup?.status().lastCompleted === undefined) throw new Error("backup did not complete")
  } finally { await host.close() }
} else if (mode === "restore") {
  const id = await restoreHostCheckpoint({ actor: actor.name, storage, backup: layer })
  const host = await createBunHost({ actor, storage })
  await host.close()
  console.log(id)
} else throw new Error(`unknown mode: ${mode}`)
