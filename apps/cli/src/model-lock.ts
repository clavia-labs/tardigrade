import { readFile, writeFile, rename, rm } from "node:fs/promises"
import { resolve } from "node:path"

import { MODEL_LOCK_FILE, modelLockOf, parseModelLock, type ModelLockData } from "@clavia/tardigrade-model/lock"
export { MODEL_LOCK_SCHEMA, MODEL_LOCK_FILE, type ModelLockData } from "@clavia/tardigrade-model/lock"

export { emptyModelLock } from "@clavia/tardigrade-model/lock"

export const writeModelLock = async (root: string, lock: ModelLockData): Promise<string> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(modelLockOf(lock, path), null, 2)}\n`, "utf8")
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return path
}

export const readModelLock = async (root: string): Promise<ModelLockData> => {
  const path = resolve(root, MODEL_LOCK_FILE)
  return parseModelLock(await readFile(path, "utf8"), path)
}
