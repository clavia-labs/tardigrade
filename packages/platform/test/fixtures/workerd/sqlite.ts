import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import type { SqliteHarness } from "../../properties/integration"
import type { TestPromiseResolver } from "./fixture.worker"

const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
export const withSqlite: SqliteHarness = check => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => check({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }))
