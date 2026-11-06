import { strict as assert } from "node:assert"
import { env } from "cloudflare:workers"
import { testStage, waitFor } from "../wait"
import type { LogLifecycleDO } from "./worker"
import type { LogLifecycleDriver, LogQueryResult, LogSearchResult, LogRequest } from "./shared"

const namespace = (env as unknown as { LOG_LIFECYCLE: DurableObjectNamespace<LogLifecycleDO> }).LOG_LIFECYCLE

// cloudflareLogLifecycle restarts native SQLite actors after a durable reply boundary.
export async function cloudflareLogLifecycle(): Promise<LogLifecycleDriver> {
  const prefix = crypto.randomUUID()
  const threads = new Set<string>()
  const stub = (thread: string) => { threads.add(thread); return namespace.getByName(`${prefix}/${thread}`) }
  const incarnation = await stub("main").instance()
  let pending: Promise<void> | undefined
  let descriptionId = 0
  const abort = async (thread: string) => {
    try { await stub(thread).reset(); assert.fail("Expected Durable Object abort") } catch (error) { assert.match(String(error), /Log lifecycle restart/) }
  }
  const request = (input: Exclude<LogRequest, { readonly type: "status" }>): Promise<unknown> => testStage("log lifecycle request", async () => await stub(input.thread).request(input))
  return {
    record: async (thread, fact, id) => { await request({ type: "record", thread, fact, id }) },
    describe: async (thread, type) => await request({ type: "recall", thread, id: `describe-${descriptionId++}`, method: "describe", input: type === undefined ? {} : { type } }) as Awaited<ReturnType<LogLifecycleDriver["describe"]>>,
    query: async (thread, sql, id, through) => await request({ type: "recall", thread, id, method: "query", input: { sql, ...(through === undefined ? {} : { through }) } }) as unknown as LogQueryResult,
    search: async (thread, query, id, options) => await request({ type: "recall", thread, id, method: "search", input: { query, ...options } }) as unknown as LogSearchResult,
    loseReply: (thread, sql, id) => testStage("waiting for durable recall reply", async () => {
      pending = stub(thread).request({ type: "recall", thread, id, method: "query", input: { sql }, loseReply: true }).then(() => { throw new Error("Reply escaped before restart") }, () => undefined)
      return await Promise.race([waitFor(() => stub(thread).boundary(), boundary => boundary !== null).then(boundary => { assert.ok(boundary); return boundary }), pending.then(() => { throw new Error("Recall ended before its durable reply") })])
    }),
    status: thread => stub(thread).status(),
    restart: () => testStage("restarting log lifecycle actors", async () => {
      for (const thread of threads) await abort(thread)
      if (pending) await pending
      pending = undefined
      assert.notEqual(await stub("main").instance(), incarnation)
    }),
    close: () => testStage("closing log lifecycle actors", async () => { for (const thread of threads) await abort(thread); if (pending) await pending }),
  }
}
