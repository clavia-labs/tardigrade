import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import fc from "fast-check"
import { eventLogCases, eventLogCompatibility } from "../properties/event-log-compatibility"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

test("0.50 event tables and row bytes survive native Grove publication, rollback and reopen", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await fc.assert(fc.asyncProperty(eventLogCases, options => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => eventLogCompatibility({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }, options))), { numRuns: 15, includeErrorInReport: true })
}, 30000)
