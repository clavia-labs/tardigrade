import { test } from "bun:test"
import { migrationProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/bun/sqlite"

for (const property of migrationProperties) test(property.name, () => property.run(withSqlite, property.bunRuns), 30_000)
