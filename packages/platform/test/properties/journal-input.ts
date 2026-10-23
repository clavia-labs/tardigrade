import { strict as assert } from "node:assert"
import { Context, Effect, Layer } from "effect"
import { atom, createEventLog, defineActor, journalCommit, type Journal, type Recorded } from "@clavia/tardigrade-core"
import { digestInput } from "@clavia/tardigrade-core/runtime/input-digest"
import { compact } from "@clavia/tardigrade-agent/atoms/compact"
import { infer } from "@clavia/tardigrade-agent/atoms/infer"
import { messages } from "@clavia/tardigrade-agent/atoms/durable/trajectory"
import { inferenceState } from "@clavia/tardigrade-agent/atoms/durable/inference"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { Generate } from "@clavia/tardigrade-agent/contracts/acts"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { Model, modelActs, type ModelInput } from "@clavia/tardigrade-agent/services/model"
import { journalModelInputs } from "@clavia/tardigrade-agent/services/journal-model-input"
import { JournalGenerate, journalInputRequests, journalModelInput, type JournalModelInput } from "@clavia/tardigrade-agent/experimental/journal-model-input"
import { createTestStore } from "./runtime/store"

const selection = { model: { provider: "test", model_id: "test" }, contextWindowTokens: 1_000_000 }

// journalInputRecipes checks pinned rendering, live reuse, future-prefix isolation, and rejection of mismatched inputs.
export const journalInputRecipes = () => {
  const context = Effect.runSync(compact(messages, { journalInputs: true, pageSize: 2, toolOutputTokenLimit: 8, userMessageTokenLimit: 8 }).pipe(Effect.provideService(ModelInfo, selection)))
  const log = createEventLog({ schema: Event, atoms: { context } })
  try {
    const records: Recorded<Event>[] = [{ event: { type: "ModelConfigured", ...selection } }]
    for (let index = 0; index < 4; index++) records.push(
      { event: { type: "TurnRequested", turnId: String(index), text: "question 🐛 ".repeat(20) } },
      { event: { type: "ModelCalled", purpose: "inference", turnId: String(index), callId: String(index), ...selection } },
      { event: { type: "ModelReturned", purpose: "inference", turnId: String(index), callId: String(index), text: "working", toolCalls: [{ callId: `tool:${index}`, providerId: String(index), name: "tool", input: {} }] } },
      { event: { type: "ToolReturned", version: 1, turnId: String(index), tool: { providerId: String(index), name: "tool" }, callId: `tool:${index}`, content: [{ type: "text", text: "result 🐛 ".repeat(20) }], error: null } },
    )
    records.push(
      { event: { type: "ModelCalled", purpose: "compaction", callId: "summary", through: 3, cursor: 5, ...selection } },
      { event: { type: "ModelReturned", purpose: "compaction", callId: "summary", text: "summary 🐛 ".repeat(20) } },
    )
    const snapshot = log.replay(records)
    const view = snapshot.view().context.view
    assert.equal(view.position, "ready")
    if (view.position !== "ready" || !view.journal) throw new Error("Missing journal recipe")
    const input: ModelInput = { model: selection.model, system: "system", tools: [], context: view.messages }
    const accepted = Generate.request({ input }).request.input
    const request: JournalModelInput = { model: selection.model, system: "system", tools: [], context: view.journal, expected: digestInput(accepted) }
    assert.deepEqual(journalModelInput(request, snapshot.get), accepted)
    assert.equal(journalModelInput(request, () => { throw new Error("Live request must not reload history") }, input), input)
    const extended = log.append(snapshot, { type: "TurnRequested", turnId: "future", text: "must not be included" })
    assert.deepEqual(journalModelInput(request, extended.get), accepted)
    assert.throws(() => journalModelInput({ ...request, context: { ...request.context, messages: { ...request.context.messages, events: ["ModelCalled"] } } }, extended.get), /selection/)
    assert.throws(() => journalModelInput({ ...request, context: { ...request.context, summary: "changed" } }, extended.get), /hash mismatch/)
    assert.throws(() => journalModelInput({ ...request, expected: { ...request.expected, sha256: "0".repeat(64) } }, extended.get, input), /hash mismatch/)
    assert.throws(() => JournalGenerate.request({ input: { ...request, context: { ...request.context, version: 2 as 1 } } }), /1/)
  } finally { log.dispose() }
}

// journalInputRecovery resumes a persisted recipe after rendering defaults change and checks the accepted input reaches the model.
export async function journalInputRecovery(open: () => Journal<Event> & { readonly close: Effect.Effect<void, Error> }) {
  const makeActor = (userMessageTokenLimit: number) => defineActor("journal-input", Effect.gen(function* () {
    const context = yield* compact(messages, { journalInputs: true, userMessageTokenLimit })
    const node = yield* infer<never>(atom(get => ({ system: "system", tools: { view: { specs: [] }, events: {}, acts: {} }, context: get(context) })))
    return { atom: journalInputRequests(node, context), schema: Event }
  }))
  const original = makeActor(262_144)
  const setup = Effect.runSync(original.setup.pipe(Effect.provideService(ModelInfo, selection)))
  const projection = createEventLog({ schema: setup.schema, atoms: setup.effects })
  let journal = open()
  const text = "original accepted input 🐛 ".repeat(4_000)
  try {
    let snapshot = projection.replay([
      { event: { type: "ModelConfigured", ...selection } },
      { event: { type: "TurnRequested", turnId: "turn", text } },
    ])
    const work = snapshot.effects()[0]!
    assert.equal(work.request.act, JournalGenerate.name)
    const ref = { seq: snapshot.position, atom: work.atom, act: work.request.act }
    snapshot = projection.append(snapshot, projection.requestEvent(ref, work.request, work.origin))
    const pending = snapshot.pending().map(({ ref, request }) => ({ ref, request }))
    assert.equal(pending.length, 1)
    assert.ok(JSON.stringify(pending).length < 2_000)
    assert.ok(!JSON.stringify(pending).includes(text))
    await Effect.runPromise(journalCommit(journal, () => journal.append(0, snapshot.records.slice(), { put: pending })))
    await Effect.runPromise(journal.close)
    projection.dispose()
    journal = open()
    assert.ok(JSON.stringify(journal.readInputs()).length < 2_000)
    const seen: ModelInput[] = []
    const provider = Layer.succeed(Model, { call: input => Effect.sync(() => { seen.push(input); return { text: "answer", toolCalls: [] } }) })
    const services = Layer.merge(Layer.succeed(ModelInfo, selection), modelActs.pipe(Layer.provideMerge(provider)))
    const store = await Effect.runPromise(createTestStore({ actor: makeActor(8), journal, actorContext: Context.pick(ModelInfo), services: runtime => journalModelInputs(runtime).pipe(Layer.provideMerge(services)) }))
    try {
      await Effect.runPromise(store.wait)
      assert.equal(seen.length, 1)
      assert.deepEqual(seen[0]!.context, [{ role: "user", text }])
      assert.equal(store.snapshot().get(inferenceState).turns.find(turn => turn.turnId === "turn")?.answer, "answer")
      assert.deepEqual(journal.readInputs(), [])
    } finally { await Effect.runPromise(store.close) }
  } finally { projection.dispose(); await Effect.runPromise(journal.close) }
}
