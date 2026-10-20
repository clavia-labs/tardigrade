import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { platformJournal } from "../../../src/shared/platform-journal"
import { cloudflareNativeDriver } from "../../../src/cloudflare/native-recovery"
import { CLOUDFLARE_SQL_LIMITS } from "../../../src/cloudflare/limits"
import { treeActorFixture, TreeEvent } from "../../properties/runtime/tree-state"

export class TreeStateDO extends DurableObject {
  private readonly journal = platformJournal<typeof TreeEvent.Type>({ actor: "tree", limits: CLOUDFLARE_SQL_LIMITS,
    driver: { ...cloudflareNativeDriver(this.ctx.storage), execute: (sql, parameters) => {
      const rows = cloudflareNativeDriver(this.ctx.storage).execute(sql, parameters)
      if (sql.startsWith("SELECT n.payload AS inline") || sql.startsWith("SELECT kind,payload")) { this.loadedNodes++; this.loadedBytes += Number(rows[0]?.byte_length ?? 0) }
      return rows
    } }, flush: Effect.tryPromise(() => this.ctx.storage.sync()),
  }, { collectEvery: 1, cacheBytes: 8192 })
  private live: ReturnType<typeof this.open> | undefined
  private loadedNodes = 0
  private loadedBytes = 0
  private async open() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tree_calls (phase TEXT, digest TEXT, count INTEGER, ref TEXT)")
    return Effect.runPromise(treeActorFixture(this.journal, (phase, input, ref) => Effect.sync(() => {
      const digest = createHash("sha256").update(JSON.stringify(input.messages)).digest("hex")
      this.ctx.storage.sql.exec("INSERT INTO tree_calls VALUES (?, ?, ?, ?)", phase, digest, input.messages.length, JSON.stringify(ref))
    })))
  }
  private current() { return this.live ??= this.open() }
  async seed() {
    const live = await this.current()
    await Effect.runPromise(live.seed)
    await Effect.runPromise(live.store.checkpoint)
  }
  async start() { await Effect.runPromise((await this.current()).start) }
  async append() { await Effect.runPromise((await this.current()).append) }
  async cancel() {
    const live = await this.current()
    const [input] = await Effect.runPromise(this.journal.readInputs)
    if (!input) throw new Error("Missing accepted input")
    await Effect.runPromise(live.store.cancel(input.ref, "stop"))
  }
  async checkpoint() { await Effect.runPromise((await this.current()).store.checkpoint) }
  async finish(cleanup: boolean) {
    const live = await this.current()
    await Effect.runPromise(cleanup ? live.finishCleanup : live.finish)
    await Effect.runPromise(live.store.wait)
    await Effect.runPromise(live.store.checkpoint)
  }
  async inspect() {
    const live = await this.current()
    return {
      state: live.store.getState().view, loadedNodes: this.loadedNodes, loadedBytes: this.loadedBytes,
      calls: this.ctx.storage.sql.exec<{ phase: string; digest: string; count: number; ref: string }>("SELECT * FROM tree_calls").toArray(),
      inputs: await Effect.runPromise(this.journal.readInputs),
      owners: this.ctx.storage.sql.exec<{ name: string; root: string }>("SELECT * FROM grove_page_owners").toArray(),
      nodes: this.ctx.storage.sql.exec<{ root: string }>("SELECT root FROM grove_page_versions").toArray().map(row => row.root),
    }
  }
  abort() { this.ctx.abort("Native tree reset fixture") }
}
