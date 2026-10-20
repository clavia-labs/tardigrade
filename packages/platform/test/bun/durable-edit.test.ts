import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fc from "fast-check"
import { Context, Effect, Layer, Schema } from "effect"
import { createActorStore, defineActor, durableAtom, effectAtom, type ActorRuntime } from "@clavia/tardigrade-core"
import { synchronousJournal } from "../../src/shared/synchronous-journal"

const Added = Schema.Struct({ type: Schema.Literal("Added"), text: Schema.String })
const State = Schema.Struct({ messages: Schema.Array(Schema.String), count: Schema.Int })

test("pure and explicit durable atoms share page checkpoints and replay event-only transitions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.string(), { minLength: 3, maxLength: 20 }), async texts => {
    const db = new Database(":memory:")
    const driver = { identity: db, execute: (sql: string, parameters: readonly (string | number | null | Uint8Array)[]) => db.query<Record<string, unknown>, (typeof parameters)[number][]>(sql).all(...parameters), transaction: <A>(work: () => A): A => db.transaction(work)() }
    let journal = synchronousJournal<typeof Added.Type>({ actor: "authoring", driver, dirtyBytes: 1024 * 1024 })
    let send!: ActorRuntime<typeof Added.Type>["send"]
    const actor = defineActor("authoring", Effect.sync(() => {
      const pure = durableAtom({ name: "pure", input: Added, schema: State, initial: { messages: [], count: 0 }, reduce: (state, event) => ({ messages: [...state.messages, event.text], count: state.count + 1 }) })
      const edited = durableAtom({ name: "edited", input: Added, schema: State, initial: { messages: [], count: 0 }, edit: (state, event) => { state.append(["messages"], [event.text]); state.set(["count"], state.read(["count"]) + 1) } })
      return { schema: Added, atom: effectAtom(get => ({ view: { pure: get(pure), edited: get(edited).read([]) }, events: {}, acts: {} })) }
    }))
    const open = () => Effect.runPromise(createActorStore({ actor, journal, checkpoint: { mode: "manual" }, actorContext: Context.pick(), services: runtime => { send = runtime.send; return Layer.empty } }))
    let runtime = await open()
    const rows = () => Number(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM grove_pages").get()!.n)
    try {
      await Effect.runPromise(runtime.checkpoint)
      const before = rows()
      for (const text of texts.slice(0, -1)) await Effect.runPromise(send([{ type: "Added", text }]))
      expect(rows()).toBe(before)
      expect(runtime.getState().view.pure).toEqual(runtime.getState().view.edited)
      await Effect.runPromise(runtime.checkpoint)
      expect(rows()).toBeGreaterThan(before)
      await Effect.runPromise(send([{ type: "Added", text: texts.at(-1)! }]))
      await Effect.runPromise(runtime.close); await Effect.runPromise(journal.close)
      journal = synchronousJournal({ actor: "authoring", driver, dirtyBytes: 1024 * 1024 })
      runtime = await open()
      expect(runtime.getState().view).toEqual({ pure: { messages: texts, count: texts.length }, edited: { messages: texts, count: texts.length } })
      await Effect.runPromise(runtime.checkpoint); await Effect.runPromise(journal.collect)
    } finally { await Effect.runPromise(runtime.close); await Effect.runPromise(journal.close); db.close() }
  }), { numRuns: 20, includeErrorInReport: true })
})
