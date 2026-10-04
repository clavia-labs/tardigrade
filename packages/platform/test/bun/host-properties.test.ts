import { test } from "bun:test"
import { propertyCases } from "../properties/suite"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bunJournal } from "../../src/bun"
import { checkpointStorage } from "../properties/checkpoint-storage"

for (const [name, run] of Object.entries(propertyCases)) test(name, run)


test("checkpointStorage", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tardie-checkpoint-"))
  const filename = join(directory, "thread.sqlite")
  const db = new Database(filename, { create: true })
  try { await checkpointStorage({ open: checkpointChunkBytes => bunJournal({ filename, actor: "events", checkpointChunkBytes }), execute: async query => db.query<Record<string, unknown>, []>(query).all() }) }
  finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
