import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import { storageProperties, type SqliteHarness } from "../properties"
import type { GroveDO } from "./fixture"

const namespace = (env as { GROVE: DurableObjectNamespace<GroveDO> }).GROVE
const native: SqliteHarness = check => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => check({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }))

for (const property of storageProperties) test(property.name, () => property.run(native, property.workerRuns), 30_000)
