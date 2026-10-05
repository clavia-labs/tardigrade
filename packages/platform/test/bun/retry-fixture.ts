import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { methodResult } from "@clavia/tardigrade-core"
import { createBunHost, bunJournal } from "../../src/bun"
import { bunThreadPath } from "../../src/bun/observe"
import { retryActor, retryServices, type RetryServiceOptions } from "../fixtures/retry-actor"
import type { RetryFixture } from "../properties/retries/lifecycle"

export async function bunRetryFixture(options: RetryServiceOptions): Promise<RetryFixture> {
  const root = await mkdtemp(join(tmpdir(), "tardie-effect-retry-"))
  const fixture = retryServices(options)
  const hostOptions = { actor: retryActor, storage: root, actorContext: Context.pick(), services: () => fixture.services }
  let host = await Effect.runPromise(createBunHost(hostOptions))
  let thread = await Effect.runPromise(host.allocateRootThread({ instance: "main", name: "thread" }))
  const journal = bunJournal({ actor: "events", filename: bunThreadPath(root, thread.coordinate) })
  return {
    start: () => Effect.runPromise(thread.invoke("run", null, { id: "run" })).then(() => {}),
    result: async () => {
      const result = await Effect.runPromise(thread.methodState("run", "run"))
      return result.status === "pending" ? undefined : Schema.decodeUnknownSync(methodResult(Schema.Finite))(result)
    },
    records: () => Effect.runPromise(journal.read),
    restart: async () => {
      await Effect.runPromise(host.close)
      host = await Effect.runPromise(createBunHost(hostOptions))
      const reopened = await Effect.runPromise(host.getThread({ instance: "main", thread: "thread" }))
      if (!reopened) throw new Error("Thread was not recovered")
      thread = reopened
      await Effect.runPromise(thread.resume)
    },
    cancel: ref => Effect.runPromise(fixture.cancel(ref)),
    stats: () => Promise.resolve({ attempts: fixture.attempts(), startedAt: fixture.startedAt() }),
    recoveryWake: async () => (await Effect.runPromise(host.probe(thread.coordinate)))?.wakeAt,
    close: async () => {
      try { await Effect.runPromise(host.close) }
      finally { await Effect.runPromise(journal.close); await rm(root, { recursive: true, force: true }) }
    },
  }
}
