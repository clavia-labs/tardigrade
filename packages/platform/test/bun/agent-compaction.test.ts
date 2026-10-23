import { atomReplay } from "../../../core/src/runtime/atom-replay"
import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import * as fc from "fast-check"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { atom, createStore, createEventLog, EventLog, RuntimeError, type EffectCheckpoint, type Recorded } from "@clavia/tardigrade-core"
import { createActor } from "@clavia/tardigrade-agent"
import { compact, DEFAULT_COMPACTION_POLICY, type CompactionOptions } from "@clavia/tardigrade-agent/atoms/compact"
import { agentLog, contentServices, selection, turn } from "../fixtures/agent"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { type Conversation } from "@clavia/tardigrade-agent/contracts/events"
import { Event } from "@clavia/tardigrade-agent/contracts/events"
import { messages } from "@clavia/tardigrade-agent/atoms/durable/trajectory"
import { infer } from "@clavia/tardigrade-agent/atoms/infer"

const file = (mediaType: string) => ({ type: "file" as const, mediaType, object: { algorithm: "sha256" as const, digest: "a".repeat(64) } })

test("unconfigured agent setup retains summary without trajectory state", async () => {
  const setup = await Effect.runPromise(createActor.setup.pipe(Effect.provide(contentServices(() => { throw new RuntimeError("Schema discovery cannot call the model") }))))
  const names = new Set(setup.inspection.durableAtoms.map(atom => atom.name))
  expect(names.has("agent.trajectory")).toBe(false)
  expect(names.has("agent.compaction.state")).toBe(true)
})


function project(messages: typeof Conversation.Type, options: CompactionOptions = {}) {
  const events = [{ type: "ModelConfigured", ...selection }]
  const store = createStore(Context.make(EventLog, { events: atom<readonly unknown[]>(events), replay: atom(atomReplay(events.map(event => ({ event })))) }))
  try {
    const node = Effect.runSync(compact(atom(messages), options).pipe(Effect.provideService(ModelInfo, selection)))
    const output = store.get(node)
    if (output.view.position === "configuring") throw new Error("Expected configured model")
    return { ...output, view: output.view }
  } finally { store.dispose() }
}

test("additive budgets count repeated resources and choose complete tool exchanges independently of tokens", () => {
  const image = { ...file("image/png"), byteSize: 4 }
  const exchange = (id: string): typeof Conversation.Type => [
    { role: "assistant", text: "", toolCalls: [{ callId: id, providerId: id, name: "read", input: {} }] },
    { role: "tool", callId: id, providerId: id, name: "read", text: "", error: false, content: [image] },
  ]
  const history: typeof Conversation.Type = [{role: "user", content: [image]}, ...exchange("one"), ...exchange("two"), {role: "user", text: "Continue"}]
  const cost = (message: typeof Conversation.Type[number]) => "content" in message ? message.content?.filter(part => part.type === "file").length ?? 0 : 0
  const before = structuredClone(history)
  const plain = project(history, {imageTokenEstimate: 0})
  const count = project(history, {imageTokenEstimate: 0, budgets: atom([{name: "items", limit: 2, retain: 1, cost}])})
  expect(plain.view.position).toBe("ready")
  expect(count.view.position).toBe("compacting")
  expect(count.view.estimatedTokens).toBe(plain.view.estimatedTokens)
  expect(count.acts.compact?.onRequested?.({seq: 0, atom: "context", act: "compact"})[0]).toMatchObject({type: "ModelCalled", purpose: "compaction", through: 3})
  expect(history).toEqual(before)
  const bytes = project(history, {imageTokenEstimate: 0, budgets: atom([{name: "encoded bytes", limit: 16, retain: 8, cost: message => 8 * cost(message)}])})
  expect(bytes.view.position).toBe("compacting")
  expect(project(history, {imageTokenEstimate: 0, budgets: atom([{name: "items", limit: 3, retain: 1, cost}])}).view.position).toBe("ready")
})

test("budget failures stop an unsplittable exchange and reject invalid or overflowing costs", () => {
  const history: typeof Conversation.Type = [{role: "user", content: [file("image/png"), file("image/png")]}]
  const budget = {name: "items", limit: 1, retain: 0, cost: () => 2}
  expect(project(history, {budgets: atom([budget])}).view.position).toBe("failed")
  for (const cost of [-1, 0.5, Infinity, Number.NaN]) expect(project(history, {budgets: atom([{...budget, cost: () => cost}])}).view.position).toBe("failed")
  const overflow = project([...history, ...history], {budgets: atom([{...budget, cost: () => Number.MAX_SAFE_INTEGER}])})
  expect(overflow.view).toMatchObject({position: "failed", reason: "Compaction budget overflow: items"})
  expect(project(history, {budgets: atom([{...budget, cost: () => {throw new Error("Resource metadata unavailable")} }])}).view).toMatchObject({position: "failed", reason: "Resource metadata unavailable"})
  for (const limit of [0, -1, 0.5, Infinity, Number.NaN]) expect(() => project(history, {budgets: atom([{...budget, limit}])})).toThrow("Invalid compaction budget")
})

for (const paged of [false, true]) test(`resource compaction settles and replays through native summaries with ${paged ? "paged" : "aggregate"} context`, () => {
  const setup = () => {
    const source = paged ? messages : atom(get => get(messages.range({limit: 64})).rows.map(row => row.value))
    const context = Effect.runSync(compact(source, {pageSize: 2, imageTokenEstimate: 0, budgets: atom([{name: "items", limit: 3, retain: 1, cost: message => "content" in message ? message.content?.filter(part => part.type === "file").length ?? 0 : 0}])}).pipe(Effect.provideService(ModelInfo, {...selection, contextWindowTokens: 100_000})))
    return Effect.runSync(infer(atom(get => ({system: "Test", tools: {view: {specs: []}, events: {}, acts: {}}, context: get(context)}))).pipe(Effect.provideService(ModelInfo, {...selection, contextWindowTokens: 100_000})))
  }
  const open = (checkpoint?: EffectCheckpoint, history?: readonly Recorded<Event>[]) => createEventLog({schema: Event, atoms: {agent: setup()}, ...(checkpoint ? {checkpoint} : {}), ...(history ? {readBefore: (position: number) => history.slice(0, position)} : {})})
  const log = open()
  const restored = open()
  try {
    let snapshot = log.initial
    let checkpoint: EffectCheckpoint | undefined
    for (let index = 0; index < 4; index++) {
      snapshot = log.append(snapshot, {type: "TurnRequested", turnId: String(index), text: "", content: [file("image/png")]})
      for (let step = 0; step < 10; step++) {
        const work = snapshot.effects().find(work => !work.ref)
        if (work) {
          const ref = {seq: snapshot.position, atom: work.atom, act: work.request.act}
          snapshot = log.append(snapshot, log.requestEvent(ref, work.request, work.origin))
          snapshot = log.append(snapshot, {type: "EffectSettled", ref, outcome: {status: "fulfilled", value: {type: "value", value: {text: work.request.act === "agent.model.summarize" ? "Summary" : "Answer", toolCalls: []}}}})
        } else {
          const proposal = Object.values(snapshot.view().agent.events)[0]
          if (!proposal) break
          snapshot = log.append(snapshot, proposal.event)
        }
      }
      if (index === 1) checkpoint = snapshot.checkpoint()
      expect(snapshot.view().agent.view.position).toBe("idle")
    }
    const history = snapshot.records.slice()
    expect(history.filter(row => row.event.type === "ModelCalled" && row.event.purpose === "compaction")).toHaveLength(1)
    expect(restored.replay(history).view()).toEqual(snapshot.view())
    const suffix = open(checkpoint, history)
    try { expect(suffix.replay(history.slice(checkpoint!.position)).view()).toEqual(snapshot.view()) }
    finally { suffix.dispose() }
    expect(turn(restored, restored.replay(history), "next", "Continue").records.slice()).toEqual(turn(log, snapshot, "next", "Continue").records.slice())
  } finally { log.dispose(); restored.dispose() }
})

for (const role of ["user", "tool"] as const) test(`compaction counts images in ${role} content and exposes the configured estimate`, () => {
  const content = [file("image/png"), file("image/jpeg")]
  const message = role === "user" ? { role, content } : { role, content, text: "", name: "screenshot", callId: "call", providerId: "call", error: false }
  const messages: typeof Conversation.Type = [message, { role: "user", text: "Continue" }]
  const textOnly = project(messages, { imageTokenEstimate: 0 })
  const withImages = project(messages)
  expect(textOnly.view.position).toBe("ready")
  expect(withImages.view.position).toBe("compacting")
  expect(withImages.view.estimatedTokens - textOnly.view.estimatedTokens).toBe(2 * DEFAULT_COMPACTION_POLICY.imageTokenEstimate)
  expect(withImages.view.policy.imageTokenEstimate).toBe(1_200)
  expect(project(messages, { imageTokenEstimate: 100 }).view.position).toBe("ready")
  expect(project(messages, { imageTokenEstimate: 100 }).view.policy.imageTokenEstimate).toBe(100)
  const proposal = withImages.acts.compact
  expect(proposal?.onRequested?.({ seq: 0, atom: "context", act: "compact" })[0]).toMatchObject({ type: "ModelCalled", purpose: "compaction", through: 1 })
})

test("compaction chooses a retained tail using image cost", () => {
  const messages: typeof Conversation.Type = [
    { role: "user", content: [file("image/png")] },
    { role: "user", content: [file("image/png")] },
    { role: "user", text: "Continue" },
  ]
  const output = project(messages)
  const event = output.acts.compact?.onRequested?.({ seq: 0, atom: "context", act: "compact" })[0]
  expect(event).toMatchObject({ type: "ModelCalled", through: 2 })
})

test("compaction leaves non-image file accounting unchanged", () => {
  const messages: typeof Conversation.Type = [{ role: "user", content: [file("application/pdf")] }]
  expect(project(messages).view.estimatedTokens).toBe(project(messages, { imageTokenEstimate: 0 }).view.estimatedTokens)
})

test("compaction rejects invalid image estimates", () => {
  for (const imageTokenEstimate of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => compact(atom<typeof Conversation.Type>([]), { imageTokenEstimate })).toThrow("imageTokenEstimate")
  }
})

test("tool content text uses the tool clipping policy and retains file refs", () => {
  const text = "x".repeat(100_000)
  const image = file("image/png")
  const output = project([{ role: "tool", name: "capture", callId: "call", providerId: "call", error: false, text, content: [{ type: "text", text }, image] }], { toolOutputTokenLimit: 10, imageTokenEstimate: 0 })
  if (output.view.position !== "ready") throw new Error("Expected ready context")
  const message = output.view.messages[0]
  if (message?.role !== "tool") throw new Error("Expected tool result")
  expect(message.text.length).toBe(40)
  expect(message.text).toContain("[truncated]")
  expect(message.content).toEqual([{ type: "text", text: message.text }, image])
})

test("compaction follows logged model configuration", () => fc.assert(fc.property(
  fc.array(fc.record({
    window: fc.integer({ min: 1_000, max: 8_000 }),
    turns: fc.integer({ min: 3, max: 4 }),
    messageRatio: fc.integer({ min: 35, max: 65 }),
    character: fc.constantFrom("x", "a", " "),
  }), { minLength: 1, maxLength: 3 }),
  fc.integer({ min: 1_000, max: 32_000 }),
  (phases, hostWindow) => {
    const original = agentLog(phases[0]!.window)
    const restored = agentLog(hostWindow)
    try {
      let snapshot = original.initial
      let checkpoint: EffectCheckpoint | undefined
      for (const [phase, { window, turns, messageRatio, character }] of phases.entries()) {
        if (phase > 0) snapshot = original.append(snapshot, { type: "ModelUpdated", ...selection, contextWindowTokens: window })
        for (let index = 0; index < turns; index++) {
          snapshot = turn(original, snapshot, `${phase}:${index}`, character.repeat(Math.floor(window * messageRatio / 100) * 4))
          checkpoint ??= snapshot.checkpoint()
        }
      }
      const history = snapshot.records.slice()
      let window: number | undefined
      let compactions = 0
      for (const { event } of history) {
        if (event.type === "ModelConfigured" || event.type === "ModelUpdated") window = event.contextWindowTokens
        if (event.type === "ModelCalled") {
          if (window === undefined) throw new Error("Model call requires logged configuration")
          expect(event.contextWindowTokens).toBe(window)
          if (event.purpose === "compaction") compactions++
        }
      }
      expect(compactions).toBeGreaterThan(0)
      const loaded = restored.replay(history)
      expect(loaded.view()).toEqual(snapshot.view())
      const pending = history.findIndex(({ event }) => event.type === "ModelCalled" && event.purpose === "compaction")
      expect(restored.replay(history.slice(0, pending + 1)).pending()[0]?.request.act).toBe("agent.model.summarize")
      const suffix = agentLog(hostWindow, checkpoint, undefined, history)
      try {
        expect(suffix.replay(history.slice(checkpoint!.position)).view()).toEqual(snapshot.view())
      } finally { suffix.dispose() }
      expect(turn(restored, loaded, "next", "Continue").records.slice()).toEqual(turn(original, snapshot, "next", "Continue").records.slice())
    } finally { original.dispose(); restored.dispose() }
  },
), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

test("compaction rejects invalid paging limits", () => {
  for (const limit of [0, -1, 0.5, Infinity, Number.NaN]) {
    expect(() => compact(atom<typeof Conversation.Type>([]), { pageSize: limit })).toThrow("pageSize")
    expect(() => compact(atom<typeof Conversation.Type>([]), { maxContextMessages: limit })).toThrow("maxContextMessages")
  }
})
