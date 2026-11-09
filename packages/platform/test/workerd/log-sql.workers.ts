import { test } from "vitest"
import { cloudflareLogQueryEngine } from "../../src/cloudflare/log-sql"
import { DEFAULT_LOG_QUERY_POLICY } from "../../src/shared/log-sql/types"
import { readOnlyLogSql } from "../scenarios/log-sql"

test("recall SQL uses native read-only classification", async () => {
  readOnlyLogSql(await cloudflareLogQueryEngine(DEFAULT_LOG_QUERY_POLICY))
})
