import { env } from "cloudflare:workers"
import { runInDurableObject } from "cloudflare:test"
import { test } from "vitest"
import fc from "fast-check"
import { agentCollectionCases, agentCollections } from "../properties/agent-collections"
import type { TestPromiseResolver } from "../fixtures/workerd/fixture.worker"

test("all agent state uses native Grove collections across Durable Object SQLite recovery", async () => {
  const namespace = (env as { PROMISE_RESOLVER: DurableObjectNamespace<TestPromiseResolver> }).PROMISE_RESOLVER
  await fc.assert(fc.asyncProperty(agentCollectionCases, options => runInDurableObject(namespace.getByName(crypto.randomUUID()), (_instance, state) => agentCollections({ identity: state.storage.sql, execute: (sql, parameters) => state.storage.sql.exec(sql, ...parameters).toArray(), transaction: work => state.storage.transactionSync(work) }, options))), { numRuns: 15, includeErrorInReport: true })
}, 30000)
