import { strict as assert } from "node:assert"
import { Schema } from "effect"
import { balanceQuery, type LogLifecycleDriver, type LogQueryResult } from "../../fixtures/log/shared"

const Result = Schema.Struct({ columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(Schema.Json)) })
const rows = (page: LogQueryResult) => {
  assert.equal(page.truncated, false)
  assert.equal(page.moreRows, false)
  return Schema.decodeUnknownSync(Result)(JSON.parse(page.text)).rows
}

// logLifecycle checks discovery, read-only recall, isolation, and saved replies across a checkpointed process death.
export async function logLifecycle(driver: LogLifecycleDriver) {
  await driver.record("main", { account: "Cedar", code: "orchid", change: 7 }, "credit")
  await driver.record("main", { account: "Cedar", code: "orchid", change: -2 }, "debit")
  await driver.record("other", { account: "Cedar", code: "private", change: 99 }, "private-credit")

  const inventory = await driver.describe("main")
  assert.ok(inventory.types.some(type => type.type === "BalanceRecorded" && type.declared))
  const description = await driver.describe("main", "BalanceRecorded")
  assert.ok(description.types[0]?.schemas.some(schema => !schema.truncated && schema.text.includes("Signed adjustment to the account balance.")))

  await assert.rejects(() => driver.query("main", "DELETE FROM events", "rewrite-history"))
  const saved = await driver.loseReply("main", balanceQuery, "recall")
  assert.ok(saved.checkpoint !== null && saved.checkpoint > 0)
  await driver.restart()

  const recovered = await driver.query("main", balanceQuery, "recall")
  assert.deepEqual(rows(recovered), [["orchid", 5]])
  assert.equal((await driver.status("main")).records, saved.records)

  await driver.record("main", { account: "Cedar", code: "orchid", change: 3 }, "later-credit")
  assert.deepEqual(await driver.query("main", balanceQuery, "recall"), recovered)
  assert.deepEqual(rows(await driver.query("main", balanceQuery, "fixed-prefix", recovered.through)), [["orchid", 5]])
  assert.deepEqual(rows(await driver.query("main", balanceQuery, "current")), [["orchid", 8]])
  assert.deepEqual(rows(await driver.query("other", balanceQuery, "other-current")), [["private", 99]])
}
