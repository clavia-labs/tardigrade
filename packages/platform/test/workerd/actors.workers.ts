import { test } from "vitest"
import { actorProperties } from "../properties/integration"
import { withSqlite } from "../fixtures/workerd/sqlite"

for (const property of actorProperties) test(property.name, () => property.run(withSqlite, property.workerRuns), 30_000)
