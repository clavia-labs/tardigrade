import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import * as fc from "fast-check"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { AtomState, atom, createStore, EventLog, type StatefulAtom, type EffectCheckpoint } from "@clavia/tardigrade-core"
import { compact, compactHistory, DEFAULT_COMPACTION_POLICY, type CompactionOptions } from "@clavia/tardigrade-agent/atoms/compact"
import { agentLog, selection, turn } from "../fixtures/agent"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { initialCompaction } from "@clavia/tardigrade-agent/atoms/durable/compaction"
import { messages, trajectoryState, TrajectoryState } from "@clavia/tardigrade-agent/atoms/durable/trajectory"
import { treeSession, prepareTreeInput } from "@clavia/tardigrade-core/services/tree-state"
import type { Event, Conversation } from "@clavia/tardigrade-agent/contracts/events"

const file = (mediaType: string) => ({ type: "file" as const, mediaType, object: { algorithm: "sha256" as const, digest: "a".repeat(64) } })


function project(messages: typeof Conversation.Type, options: CompactionOptions = {}) {
  const store = createStore(Context.make(EventLog, { events: atom<readonly unknown[]>([{ type: "ModelConfigured", ...selection }]) }))
  try {
    const node = Effect.runSync(compact(atom(messages), options).pipe(Effect.provideService(ModelInfo, selection)))
    const output = store.get(node)
    if (output.view.position === "configuring") throw new Error("Expected configured model")
    return { ...output, view: output.view }
  } finally { store.dispose() }
}

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
      const suffix = agentLog(hostWindow, checkpoint, undefined, original.trees)
      try {
        expect(suffix.replay(history.slice(checkpoint!.position)).view()).toEqual(snapshot.view())
      } finally { suffix.dispose() }
      expect(turn(restored, loaded, "next", "Continue").records.slice()).toEqual(turn(original, snapshot, "next", "Continue").records.slice())
    } finally { original.dispose(); restored.dispose() }
  },
), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)

function historyProjection(seed?: ReadonlyMap<string, unknown>, stored = new Map<string, string>(), options: CompactionOptions = {}) {
  const events = atom<readonly Event[]>(seed?.has("agent.model") ? [] : [{ type: "ModelConfigured", ...selection }])
  const trees = treeSession({ options: { cacheBytes: 0 }, load: hash => {
    const text = stored.get(hash)
    if (text === undefined) throw new Error("Missing checkpoint node")
    return text
  } })
  const store = createStore(Context.make(EventLog, { events, trees, ...(seed ? { initialState: { position: 0, state: seed } } : {}) }))
  const provide = Effect.provideService(ModelInfo, selection)
  const history = Effect.runSync(compactHistory(options).pipe(provide))
  const legacy = Effect.runSync(compact(messages, options).pipe(provide))
  const output = () => {
    const result = store.get(history)
    return { ...result, view: result.view.position === "ready" ? { ...result.view, messages: trees.resolve(prepareTreeInput(result.view.messages)) } : result.view }
  }
  return {
    store, trees, output, selected: () => store.get(history).view,
    append: (event: Event) => store.set(events, list => [...list, event]),
    compare: () => {
      const current = output()
      const previous = store.get(legacy)
      expect(current.view).toEqual(previous.view)
      const ref = { seq: 0, atom: "context", act: "compact" }
      expect(current.acts.compact?.onRequested?.(ref)).toEqual(previous.acts.compact?.onRequested?.(ref))
    },
    capture: () => {
      output()
      const seed = new Map<string, unknown>()
      for (const node of store.nodes().values()) {
        const codec = (node.atom as Partial<StatefulAtom>)[AtomState]
        if (codec) seed.set(codec.name, codec.encode(store.get(node.atom)))
      }
      const staged = trees.nodes()
      for (const [hash, node] of staged) stored.set(hash, node.text)
      trees.committed(staged)
      return seed
    },
    archive: () => store.get(trajectoryState).read(["entries"]),
  }
}

test("Grove context matches compaction while the archive and accepted inputs retain original messages", () => {
  const projection = historyProjection(undefined, undefined, { toolOutputTokenLimit: 10, imageTokenEstimate: 0 })
  const model = { model: selection.model, contextWindowTokens: selection.contextWindowTokens }
  const text = "x".repeat(100_000)
  const events: Event[] = [
    { type: "TurnRequested", turnId: "first", text: "Capture" },
    { type: "ModelCalled", purpose: "inference", turnId: "first", callId: "model", ...model },
    { type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [{ callId: "tool", providerId: "provider", name: "capture", input: {} }] },
    { type: "ToolReturned", version: 1, callId: "tool", content: [{ type: "text", text }, file("image/png")], error: null },
    { type: "TurnRequested", turnId: "second", text: "Continue" },
  ]
  try {
    for (const event of events) { projection.append(event); projection.compare() }
    const context = projection.output().view
    if (context.position !== "ready") throw new Error("Expected ready context")
    expect(context.messages).toMatchObject([{}, {}, { text: expect.stringContaining("[truncated]") }, {}])
    const selected = projection.selected()
    if (selected.position !== "ready") throw new Error("Expected selected context")
    const accepted = prepareTreeInput(selected.messages)
    projection.append({ type: "ModelCalled", purpose: "compaction", callId: "summary", through: 3, ...model })
    projection.compare()
    projection.append({ type: "ModelReturned", purpose: "compaction", callId: "summary", text: "Captured the screen." })
    projection.compare()
    expect(projection.output().view).toMatchObject({ messages: [{ text: expect.stringContaining("Captured the screen.") }, { text: "Continue" }] })
    expect(projection.trees.resolve(accepted)).toEqual(context.messages)
    expect(projection.archive()[2]?.message).toMatchObject({ text, content: [{ type: "text", text }, file("image/png")] })
    expect(projection.archive()).toHaveLength(4)
  } finally { projection.store.dispose() }
})

for (const tree of [false, true]) test(`context upgrades ${tree ? "tree" : "inline"} checkpoints and reapplies changed clipping policy`, () => {
  const stored = new Map<string, string>()
  const archive = { entries: [
    { turnId: "old", message: { role: "user" as const, text: "summarized" } },
    { turnId: "tail", message: { role: "user" as const, text: "z".repeat(500) } },
  ], models: [] }
  const seed = new Map<string, unknown>([["agent.trajectory", archive], ["agent.compaction.state", { ...initialCompaction, through: 1, summary: "Earlier" }]])
  if (tree) {
    const session = treeSession({ load: () => { throw new Error("Unexpected load") } })
    seed.set("agent.trajectory", { _tag: "TreeState", root: session.bind(TrajectoryState).initial(archive).root })
    for (const [hash, node] of session.nodes()) stored.set(hash, node.text)
  }
  const original = historyProjection(seed, stored)
  let restored: ReturnType<typeof historyProjection> | undefined
  try {
    original.append({ type: "TurnRequested", turnId: "new", text: "Suffix" })
    expect(original.output().view).toMatchObject({ messages: [{ text: expect.stringContaining("Earlier") }, { text: "z".repeat(500) }, { text: "Suffix" }] })
    const checkpoint = original.capture()
    expect(checkpoint.has("agent.context")).toBe(true)
    expect(checkpoint.has("agent.trajectory")).toBe(true)
    restored = historyProjection(checkpoint, stored, { userMessageTokenLimit: 20 })
    expect(restored.output().view).toMatchObject({ messages: [{ text: expect.stringContaining("Earlier") }, { text: expect.stringContaining("[truncated]") }, { text: "Suffix" }] })
    expect(restored.archive()).toEqual([...archive.entries, { turnId: "new", message: { role: "user", text: "Suffix" } }])
  } finally { original.store.dispose(); restored?.store.dispose() }
})
