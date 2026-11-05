import { DurableObject } from "cloudflare:workers"
import { Context, Effect } from "effect"
import { createActorStore, resolveMethodResult } from "@clavia/tardigrade-core"
import { cloudflareJournal } from "../../../src/cloudflare"
import { actor, services } from "./actor"
import type { LogRequest, LogStatus } from "./shared"

type LogEvent = Effect.Success<typeof actor.setup>["schema"]["Type"]

export class LogLifecycleDO extends DurableObject {
  private readonly incarnation = crypto.randomUUID()
  private readonly journal = cloudflareJournal<LogEvent>(this.ctx.storage, "events", { eventInlineBytes: 64, checkpointChunkBytes: 31 })
  private readonly store = this.ctx.blockConcurrencyWhile(() => Effect.runPromise(createActorStore({
    actor, journal: this.journal, actorContext: Context.pick(), services: () => services,
    checkpoint: { mode: "threshold", options: { everyEvents: 1 } },
  })))
  private reached: LogStatus | null = null

  instance() { return this.incarnation }
  boundary() { return this.reached }
  reset() { this.ctx.abort("Log lifecycle restart") }
  status(): LogStatus { return { records: this.journal.readPosition(), checkpoint: this.journal.readCheckpoint()?.position ?? null } }
  async request(request: Exclude<LogRequest, { readonly type: "status" }>) {
    const store = await this.store
    const method = request.type === "record" ? "record" : "recall"
    const input = request.type === "record" ? { ...request.fact } : { method: request.method, input: request.input }
    await Effect.runPromise(store.receive({ method, input }, { id: request.id, from: { kind: "external", id: "scenario" } }).pipe(Effect.andThen(store.wait)))
    const context = { id: request.id, ref: { method, id: request.id } }
    const result = method === "record" ? resolveMethodResult(store.contracts.record, input, store.get, context) : resolveMethodResult(store.contracts.recall, input, store.get, context)
    if (result?.status !== "completed") throw new Error(result?.status === "failed" ? result.error : "Recall did not complete")
    if (request.type === "recall" && request.loseReply) {
      await this.ctx.storage.sync()
      this.reached = this.status()
      return await Effect.runPromise(Effect.never)
    }
    return result.output
  }
}
