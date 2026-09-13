import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { MODEL_LOCK_SCHEMA, MODEL_LOCK_FILE, modelConfigDigest, modelLockOf, type ModelLock } from "@clavia/tardigrade-model/lock"
export { MODEL_LOCK_SCHEMA, MODEL_LOCK_FILE, type ModelLock } from "@clavia/tardigrade-model/lock"

export const emptyModelLock = async (): Promise<ModelLock> => ({
  schema: MODEL_LOCK_SCHEMA,
  configDigest: await modelConfigDigest({ allow: "*", providers: {} }),
  catalog: {
    source: "custom",
    revision: "empty",
    refreshedAt: 0,
    status: "cached",
    providers: []
  }
})

export const writeModelLock = async (root: string, lock: ModelLock): Promise<string> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8")
  return path
}

export const readModelLock = async (root: string): Promise<ModelLock> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  return modelLockOf(JSON.parse(await readFile(path, "utf8")))
}
