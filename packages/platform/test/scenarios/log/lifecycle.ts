import { strict as assert } from "node:assert"
import { Schema } from "effect"
import { PRIVATE_RECALL_INPUT } from "../../fixtures/log/actor"
import { balanceQuery, type LogLifecycleDriver, type LogQueryResult } from "../../fixtures/log/shared"

const Result = Schema.Struct({ columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(Schema.Json)) })
const rows = (page: LogQueryResult) => {
  assert.equal(page.truncated, false)
  assert.equal(page.moreRows, false)
  return Schema.decodeUnknownSync(Result)(JSON.parse(page.text)).rows
}

// logLifecycle checks discovery, read-only recall, isolation, and saved replies across a checkpointed process death.
export async function logLifecycle(driver: LogLifecycleDriver) {
  const code = "orchid meadow " + "é".repeat(32)
  await driver.record("main", { account: "Cedar", code, change: 7 }, "credit")
  await driver.record("main", { account: "Cedar", code, change: -2 }, "debit")
  await driver.record("other", { account: "Cedar", code: "private", change: 99 }, "private-credit")

  const found = await driver.search("main", '"orchid meadow"', "find-code", { type: "BalanceRecorded" })
  assert.equal(found.hits.length, 2)
  assert.ok(found.hits.every(hit => hit.type === "BalanceRecorded" && hit.snippet.includes("orchid") && !hit.truncated))
  assert.equal((await driver.search("main", "private", "find-private", { type: "BalanceRecorded" })).hits.length, 0)
  assert.equal((await driver.search("main", PRIVATE_RECALL_INPUT, "find-input", { through: found.through })).hits.length, 0)
  const privateInput = await driver.query("main", `SELECT record FROM events WHERE record LIKE '%${PRIVATE_RECALL_INPUT}%'`, "query-input", found.through)
  assert.deepEqual(rows(privateInput), [])
  const first = Math.min(...found.hits.map(hit => hit.position))
  assert.deepEqual((await driver.search("main", "orchid", "first-match", { type: "BalanceRecorded", through: first + 1 })).hits.map(hit => hit.position), [first])

  const inventory = await driver.describe("main")
  assert.ok(inventory.types.some(type => type.type === "BalanceRecorded" && type.declared))
  const untagged = await driver.describe("main", null)
  assert.equal(untagged.types.length, 1)
  assert.equal(untagged.types[0]!.type, null)
  assert.ok(untagged.types[0]!.schemas.some(schema => schema.text.includes("untaggedNote")))
  const description = await driver.describe("main", "BalanceRecorded")
  assert.ok(description.types[0]?.schemas.some(schema => !schema.truncated && schema.text.includes("Signed adjustment to the account balance.")))

  for (const [id, sql] of [
    ["rewrite-history", "DELETE FROM events"],
    ["private-storage", 'SELECT event FROM main."experimental_events"'],
    ["database-schema", "SELECT * FROM sqlite_schema"],
    ["escape-query", "SELECT 1); DELETE FROM events; SELECT (1"],
  ] as const) await assert.rejects(() => driver.query("main", sql, id))
  const saved = await driver.loseReply("main", balanceQuery, "recall")
  assert.ok(saved.checkpoint !== null && saved.checkpoint > 0)
  await driver.restart()

  const recovered = await driver.query("main", balanceQuery, "recall")
  assert.deepEqual(rows(recovered), [[code, 5]])
  assert.equal((await driver.status("main")).records, saved.records)

  const persistedSearch = await driver.search("main", "orchid", "search-after-restart", { type: "BalanceRecorded", through: found.through })
  assert.deepEqual(persistedSearch.hits.map(hit => hit.position).sort((a, b) => a - b), found.hits.map(hit => hit.position).sort((a, b) => a - b))
  await driver.record("main", { account: "Cedar", code, change: 3 }, "later-credit")
  assert.deepEqual(await driver.query("main", balanceQuery, "recall"), recovered)
  assert.deepEqual(rows(await driver.query("main", balanceQuery, "fixed-prefix", recovered.through)), [[code, 5]])
  assert.deepEqual(rows(await driver.query("main", balanceQuery, "current")), [[code, 8]])
  assert.deepEqual(rows(await driver.query("other", balanceQuery, "other-current")), [["private", 99]])
  const currentSearch = await driver.search("main", "orchid", "search-current", { type: "BalanceRecorded", limit: 1 })
  assert.equal(currentSearch.hits.length, 1)
  assert.equal(currentSearch.more, true)
  assert.equal((await driver.search("main", "orchid", "search-fixed", { type: "BalanceRecorded", through: found.through })).hits.length, 2)

  const coldStart = await driver.status("main")
  const distantBoundary = Math.max(coldStart.records + currentSearch.indexPolicy.maxIndexEvents + 1, currentSearch.policy.maxScanEvents + 1)
  for (let index = coldStart.records; index < distantBoundary; index++) {
    await driver.record("main", { account: "Cedar", code: "filler", change: 0 }, `filler-${index}`)
  }
  await driver.record("main", { account: "Cedar", code: "distant lighthouse", change: 0 }, "distant")
  const through = (await driver.status("main")).records
  await assert.rejects(() => driver.search("main", '"distant lighthouse"', "cold-search", { through }), (error: unknown) => {
    assert.ok(error instanceof Error && error.cause instanceof Error)
    assert.match(error.cause.message, /Search index incomplete: indexedThrough .*maxIndexEvents 64/)
    return true
  })
  const resumed = await driver.search("main", '"distant lighthouse"', "resume-search", { through })
  assert.equal(resumed.hits.length, 1)
  assert.ok(resumed.hits[0]!.position > resumed.policy.maxScanEvents)
  assert.equal(resumed.indexedThrough, through)
  const point = await driver.query("main", `SELECT json_extract(event, '$.code') FROM events WHERE position = ${resumed.hits[0]!.position}`, "distant-query", through)
  assert.deepEqual(rows(point), [["distant lighthouse"]])
  assert.equal(point.readEvents, 1)
}
