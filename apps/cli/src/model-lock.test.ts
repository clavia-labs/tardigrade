import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runtimeModelLock as lock } from "@clavia/tardigrade-model/testing/models"
import { readModelLock, writeModelLock } from "./model-lock"

test("lock persistence preserves definitions and failed writes leave the saved file intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "tdg-model-lock-"))
  try {
    const path = await writeModelLock(root, lock)
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(lock)
    expect(await readModelLock(root)).toEqual(lock)
    await expect(writeModelLock(root, { ...lock, models: [...lock.models, ...lock.models] })).rejects.toThrow("duplicate model")
    expect(await readModelLock(root)).toEqual(lock)
    expect(await readdir(root)).toEqual(["models.lock.json"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
