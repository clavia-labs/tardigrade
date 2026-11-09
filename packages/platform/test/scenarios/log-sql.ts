import assert from "node:assert/strict"
import type { Recorded } from "@clavia/tardigrade-core"
import { bridgeQuery } from "../../src/shared/log-sql/bridge"
import { DEFAULT_LOG_QUERY_POLICY, type Sqlite } from "../../src/shared/log-sql/types"

// readOnlyLogSql checks native function classification, recursive work limits, and journal isolation on both WASM hosts.
export function readOnlyLogSql(sqlite: Sqlite) {
  const records: Recorded<unknown>[] = [
    { event: { type: "Fact", text: " orchid meadow ", amount: 7 } },
    { event: { type: "Fact", text: "orchid shore", amount: -2 } },
  ]
  const original = JSON.stringify(records)
  const source = { readPosition: () => records.length, readRange: (from: number, to: number) => records.slice(from, to) }
  const query = (sql: string, policy = DEFAULT_LOG_QUERY_POLICY) => bridgeQuery(sqlite, source, { sql, from: 0, to: records.length, limit: 20 }, policy)
  const cases: readonly [string, unknown[][]][] = [
    ["SELECT instr('orchid meadow', 'meadow'), trim(' orchid '), replace('orchid', 'or', 'OR'), substring('orchid', 2, 3), concat('a', 'b'), nullif(1, 1)", [[8, "orchid", "ORchid", "rch", "ab", null]]],
    ["SELECT json_valid('{}'), json_object('value', 2), json_array(1, 2), '{\"value\":3}' ->> '$.value'", [[1, '{"value":2}', '[1,2]', 3]]],
    ["SELECT group_concat(position, ','), json_group_array(position) FROM events", [["0,1", "[0,1]"]]],
    ["SELECT position, row_number() OVER (ORDER BY position), lag(position) OVER (ORDER BY position) FROM events", [[0, 1, null], [1, 2, 0]]],
    ["SELECT floor(2.8), ceil(2.2), sqrt(9), pow(2, 3), mod(7, 3)", [[2, 3, 3, 8, 1]]],
    ["SELECT date('2026-01-02'), unixepoch('1970-01-01'), typeof(3)", [["2026-01-02", 0, "integer"]]],
    ["WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4) SELECT sum(n) FROM sequence", [[10]]],
    ["WITH selected AS (SELECT position FROM events) SELECT * FROM selected UNION SELECT 2", [[0], [1], [2]]],
  ]
  for (const [sql, expected] of cases) assert.deepEqual(query(sql).rows, expected, sql)
  assert.equal(query("SELECT length(hex(randomblob(4)))").rows[0]![0], 8)
  assert.equal(query("SELECT length(current_timestamp)").rows[0]![0], 19)

  for (const sql of [
    "INSERT INTO events(position) VALUES(3)", "UPDATE events SET type = 'Changed'", "DELETE FROM events", "DROP TABLE events",
    "CREATE TABLE escaped(value)", "CREATE TEMP TABLE escaped(value)", "ATTACH ':memory:' AS escaped", "BEGIN", "COMMIT",
    "PRAGMA query_only=OFF", "PRAGMA writable_schema=ON", "PRAGMA table_info(events)",
    "SELECT * FROM sqlite_schema", "SELECT * FROM pragma_function_list", "SELECT * FROM main.experimental_events",
    "SELECT sqlite_log(1, 'side effect')", "SELECT load_extension('escape')", "SELECT writefile('escape', 'value')",
    "SELECT 1; SELECT 2", "SELECT 1; PRAGMA query_only=OFF",
  ]) assert.throws(() => query(sql), Error, sql)

  assert.throws(() => query("WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM sequence) SELECT sum(n) FROM sequence", { ...DEFAULT_LOG_QUERY_POLICY, maxInstructions: 1_000 }), /maxInstructions 1000/)
  assert.throws(() => query("SELECT hex(zeroblob(1000))", { ...DEFAULT_LOG_QUERY_POLICY, maxResultBytes: 100 }), /maxResultBytes 100/)
  const point = query("SELECT trim(json_extract(event, '$.text')) FROM events WHERE position = 0")
  assert.deepEqual(point.rows, [["orchid meadow"]])
  assert.equal(point.readEvents, 1)
  assert.equal(JSON.stringify(records), original)
}
