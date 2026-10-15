import { expect, test } from "bun:test"
import { Context, Effect } from "effect"
import * as fc from "fast-check"
import { RUNTIME_PROPERTY_OPTIONS, RUNTIME_PROPERTY_TEST_TIMEOUT_MS } from "../properties/runtime/config"
import { atom, createStore, EventLog, type EffectCheckpoint } from "@clavia/tardigrade-core"
import { compact, DEFAULT_COMPACTION_POLICY, type CompactionOptions } from "@clavia/tardigrade-agent/atoms/compact"
import { agentLog, selection, turn } from "../fixtures/agent"
import { ModelInfo } from "@clavia/tardigrade-agent/actor/context"
import { type Conversation } from "@clavia/tardigrade-agent/contracts/events"

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
      const suffix = agentLog(hostWindow, checkpoint)
      try {
        expect(suffix.replay(history.slice(checkpoint!.position)).view()).toEqual(snapshot.view())
      } finally { suffix.dispose() }
      expect(turn(restored, loaded, "next", "Continue").records.slice()).toEqual(turn(original, snapshot, "next", "Continue").records.slice())
    } finally { original.dispose(); restored.dispose() }
  },
), RUNTIME_PROPERTY_OPTIONS), RUNTIME_PROPERTY_TEST_TIMEOUT_MS)
