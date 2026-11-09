import { test } from "bun:test"
import { bunLogQueryEngine } from "../../src/bun/log-sql"
import { DEFAULT_LOG_QUERY_POLICY } from "../../src/shared/log-sql/types"
import { readOnlyLogSql } from "../scenarios/log-sql"

test("recall SQL uses native read-only classification", async () => {
  readOnlyLogSql(await bunLogQueryEngine(DEFAULT_LOG_QUERY_POLICY))
})
