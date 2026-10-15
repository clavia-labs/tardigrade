import { DurableObject } from "cloudflare:workers"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { cloudflareJournal } from "../../../src/cloudflare"
import { treeActorFixture, TreeEvent } from "../../properties/runtime/tree-state"

export class TreeStateDO extends DurableObject {
  private readonly journal = cloudflareJournal<typeof TreeEvent.Type>(this.ctx.storage, "tree", { checkpointTree: { collectEvery: 1, cacheBytes: 8192 } })
  private live: ReturnType<typeof this.open> | undefined
  private loadedNodes = 0
  private loadedBytes = 0
  private open() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tree_calls (phase TEXT, digest TEXT, count INTEGER, ref TEXT)")
    const storage = this.journal.trees!
    return Effect.runPromise(treeActorFixture({ ...this.journal, trees: { ...storage, load: hash => {
      const text = storage.load(hash)
      this.loadedNodes++; this.loadedBytes += Buffer.byteLength(text)
      return text
    } } }, (phase, input, ref) => Effect.sync(() => {
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
      owners: this.ctx.storage.sql.exec<{ name: string; root: string }>("SELECT * FROM grove_owners").toArray(),
      nodes: this.ctx.storage.sql.exec<{ hash: string }>("SELECT hash FROM grove_nodes").toArray().map(row => row.hash),
    }
  }
  abort() { this.ctx.abort("Native tree reset fixture") }
}
