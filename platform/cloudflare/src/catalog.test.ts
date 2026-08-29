import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { CLOUDFLARE_MODEL_CATALOG_MIGRATION } from "./catalog-migration"

test("the exported catalog migration matches the Wrangler migration", async () => {
  const source = await readFile(new URL("../migrations/0001_catalog.sql", import.meta.url), "utf8")

  expect(source).toBe(CLOUDFLARE_MODEL_CATALOG_MIGRATION)
})
