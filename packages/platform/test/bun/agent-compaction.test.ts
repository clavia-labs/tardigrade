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
import { Event, type Conversation } from "@clavia/tardigrade-agent/contracts/events"

import { messages as trajectoryMessages } from "@clavia/tardigrade-agent/atoms/durable/trajectory"

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

function usageLog(paged: boolean, checkpoint?: EffectCheckpoint, history?: readonly Recorded<Event>[]) {
  const source = paged ? trajectoryMessages : atom(get => get(trajectoryMessages.range({ limit: 1_000 })).rows.map(row => row.value))
  const context = Effect.runSync(compact(source).pipe(Effect.provideService(ModelInfo, selection)))
  return createEventLog({ schema: Event, atoms: { context }, ...(checkpoint ? { checkpoint } : {}), ...(history ? { readBefore: (position: number) => history.slice(0, position) } : {}) })
}

function tokensOf(snapshot: ReturnType<ReturnType<typeof usageLog>["replay"]>) {
  const view = snapshot.view().context.view
  if (view.position === "configuring") throw new Error("Expected configured model")
  return view.estimatedTokens
}

const usageHistory = (input: number | undefined = 30_000): Recorded<Event>[] => [
  { event: { type: "ModelConfigured", ...selection, contextWindowTokens: 48_000 } },
  { event: { type: "TurnRequested", turnId: "first", text: "Page", content: [file("image/png")] } },
  { event: { type: "ModelCalled", purpose: "inference", turnId: "first", callId: "first", ...selection, contextWindowTokens: 48_000 } },
  { event: { type: "ModelReturned", purpose: "inference", callId: "first", text: "Answer", toolCalls: [], ...(input === undefined ? {} : { usage: { input, output: 100, cacheRead: input, cacheWrite: input, usd: null } }) } },
]

for (const paged of [false, true]) {
  test(`compaction anchors usage and estimates appended messages (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      let snapshot = log.replay(usageHistory())
      expect(tokensOf(snapshot)).toBe(30_100)
      snapshot = log.append(snapshot, { type: "TurnRequested", turnId: "next", text: "Page", content: [file("image/png")] })
      const imageSize = JSON.stringify({ role: "user", content: [file("image/png")] }).length / 4 + 1_200
      expect(tokensOf(snapshot)).toBe(Math.ceil(30_100 + imageSize))
      snapshot = log.append(snapshot, { type: "ModelCalled", purpose: "inference", turnId: "next", callId: "next", ...selection })
      snapshot = log.append(snapshot, { type: "ModelReturned", purpose: "inference", callId: "next", text: "Next", toolCalls: [], usage: { input: 39_000, output: 100, usd: null } })
      expect(snapshot.view().context.view.position).toBe("compacting")
      expect(tokensOf(snapshot)).toBe(39_100)
      const proposal = snapshot.view().context.acts.compact!
      const ref = { seq: snapshot.position, atom: "context", act: "compact" }
      const called = proposal.onRequested!(ref)[0] as Event
      expect(called).toMatchObject({ type: "ModelCalled", purpose: "compaction", through: 2 })
      snapshot = log.append(snapshot, called)
      snapshot = log.append(snapshot, { type: "ModelReturned", purpose: "compaction", callId: "compact:2:0", text: "Summary", usage: { input: 40_000, output: 100, usd: null } })
      expect(snapshot.view().context.view.position).toBe("ready")
      expect(tokensOf(snapshot)).toBeLessThan(2_000)
    } finally { log.dispose() }
  })

  test(`compaction ignores previous models and keeps its estimate floor (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      const original = log.replay(usageHistory())
      for (const model of [{ provider: "other", model_id: "test" }, { provider: "test", model_id: "other" }]) {
        const changed = log.append(original, { type: "ModelUpdated", model, contextWindowTokens: 48_000 })
        expect(tokensOf(changed)).toBeLessThan(2_000)
        const restored = log.append(changed, { type: "ModelUpdated", ...selection, contextWindowTokens: 48_000 })
        expect(tokensOf(restored)).toBeLessThan(2_000)
      }
      expect(tokensOf(log.replay(usageHistory(1)))).toBeGreaterThan(1_200)
    } finally { log.dispose() }
  })

  test(`compaction retains usage across missing and failed calls (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      let snapshot = log.replay(usageHistory())
      snapshot = log.append(snapshot, { type: "TurnRequested", turnId: "next", text: "Continue" })
      snapshot = log.append(snapshot, { type: "ModelCalled", purpose: "inference", turnId: "next", callId: "next", ...selection })
      const before = tokensOf(snapshot)
      const failed = log.append(snapshot, { type: "ModelFailed", callId: "next", reason: "failed" })
      expect(tokensOf(failed)).toBe(before)
      const refused = log.append(snapshot, { type: "OutputRejected", turnId: "next", callId: "next", contract: "answer", text: "invalid", errors: ["invalid"], attempt: 1, maxCorrections: 2 })
      expect(tokensOf(refused)).toBe(before)
      for (const usage of [undefined, { output: 20, usd: null }]) {
        const returned = log.append(snapshot, { type: "ModelReturned", purpose: "inference", callId: "next", text: "Reply", toolCalls: [], ...(usage ? { usage } : {}) })
        expect(tokensOf(returned)).toBeGreaterThan(before)
        expect(tokensOf(returned)).toBeLessThan(before + 100)
      }
    } finally { log.dispose() }
  })

  test(`compaction estimates tool images after the anchor (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      const history = usageHistory()
      const reply = history[3]!.event
      if (reply.type !== "ModelReturned" || reply.purpose !== "inference") throw new Error("Expected inference reply")
      history[3] = { event: { ...reply, toolCalls: [{ callId: "capture", providerId: "capture", name: "capture", input: {} }] } }
      let snapshot = log.replay(history)
      snapshot = log.append(snapshot, { type: "ToolReturned", version: 1, callId: "capture", content: [file("image/png")], error: null })
      expect(tokensOf(snapshot)).toBeGreaterThan(31_300)
      expect(tokensOf(snapshot)).toBeLessThan(31_500)
    } finally { log.dispose() }
  })

  test(`compaction bounds image-heavy usage overshoot (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      let snapshot = log.replay([{ event: { type: "ModelConfigured", ...selection, contextWindowTokens: 48_000 } }])
      let latestInput = 0
      for (let image = 1; image <= 26; image++) {
        snapshot = log.append(snapshot, { type: "TurnRequested", turnId: `${image}`, text: "Page", content: [file("image/png")] })
        if (snapshot.view().context.view.position === "compacting") break
        snapshot = log.append(snapshot, { type: "ModelCalled", purpose: "inference", turnId: `${image}`, callId: `${image}`, ...selection, contextWindowTokens: 48_000 })
        latestInput = image * 2_548
        snapshot = log.append(snapshot, { type: "ModelReturned", purpose: "inference", callId: `${image}`, text: "Answer", toolCalls: [], usage: { input: latestInput, output: 100, usd: null } })
        if (snapshot.view().context.view.position === "compacting") break
      }
      expect(snapshot.view().context.view.position).toBe("compacting")
      expect(latestInput).toBeLessThanOrEqual(38_400 + 1_300)
    } finally { log.dispose() }
  })

  test(`compaction without reported input keeps native accounting (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      const history = usageHistory().map(record => {
        const event = record.event
        if (event.type !== "ModelReturned") return record
        const { usage: _usage, ...withoutUsage } = event
        return { event: withoutUsage }
      })
      const snapshot = log.replay(history)
      const native = project([{ role: "user", content: [file("image/png")] }, { role: "assistant", text: "Answer", toolCalls: [] }])
      expect(tokensOf(snapshot)).toBe(native.view.estimatedTokens)
    } finally { log.dispose() }
  })

  for (const checkpointPosition of [3, 4]) test(`compaction usage survives checkpoint at ${checkpointPosition} plus suffix (paged=${paged})`, () => {
    const log = usageLog(paged)
    try {
      let snapshot = log.replay(usageHistory().slice(0, checkpointPosition))
      const checkpoint = snapshot.checkpoint()!
      const history = usageHistory()
      for (let index = 0; index < 8; index++) history.push({ event: { type: "TurnRequested", turnId: `next:${index}`, text: "Page", content: [file("image/png")] } })
      snapshot = log.replay(history)
      const restored = usageLog(paged, checkpoint, history)
      try {
        const loaded = restored.replay(history.slice(checkpoint.position))
        expect(loaded.view().context.view).toEqual(snapshot.view().context.view)
        const ref = { seq: snapshot.position, atom: "context", act: "compact" }
        expect(loaded.view().context.acts.compact?.onRequested?.(ref)).toEqual(snapshot.view().context.acts.compact?.onRequested?.(ref))
        expect(loaded.checkpoint()!.durable.find(entry => entry.name === "agent.compaction.state")?.state).toEqual(snapshot.checkpoint()!.durable.find(entry => entry.name === "agent.compaction.state")?.state)
      } finally { restored.dispose() }
    } finally { log.dispose() }
  })
}
