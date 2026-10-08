import { Schema } from "effect"
import * as fc from "fast-check"
import { act, createEventLog, decodeCheckpoint, durableAtom, effectAtom, encodeCheckpoint, type EffectCheckpoint } from "@clavia/tardigrade-core"
import { storeRequest } from "../../../../core/src/runtime/input-digest"

const Started = Schema.Struct({ type: Schema.Literal("Started"), text: Schema.String })
const Job = act({ name: "test.settledEffect", input: Schema.Struct({ system: Schema.String, text: Schema.String }), success: Schema.String, failure: Schema.String })
const outcomes = ["value", "rejected", "promise", "deferred", "pending"] as const

// eventLog offers one Job for the started text while system is defined; system stands in for an author-edited prompt.
const eventLog = (system: string | undefined, digestMinBytes: number, checkpoint?: EffectCheckpoint) => {
  const state = durableAtom({ name: "settledEffect.state", input: Started, schema: Schema.NullOr(Schema.String), initial: null, reduce: (_, event) => event.text })
  let request: ReturnType<typeof Job.request> | undefined
  const root = effectAtom(get => {
    const text = get(state)
    if (text !== null && system !== undefined) request ??= Job.request({ input: { system, text } })
    return { view: text, events: {}, acts: request ? { call: request } : {} }
  })
  return createEventLog({ schema: Started, atoms: { root }, digestMinBytes, ...(checkpoint ? { checkpoint } : {}) })
}

const rejected = (run: () => unknown) => {
  try { run() } catch (error) { return error instanceof Error && error.message.includes("differs from its proposal") }
  return false
}

const cases = fc.record({
  original: fc.string(), edited: fc.string(), text: fc.string(), outcome: fc.constantFrom(...outcomes),
  digestMinBytes: fc.constantFrom(0, Number.MAX_SAFE_INTEGER), fromCheckpoint: fc.boolean(),
}).filter(({ original, edited }) => original !== edited)

// settledEffect checks that replay ignores a changed input only after a terminal outcome and still requires the proposal (quint/checkpoint/inputLifecycle.qnt, verifiedExecution).
export const settledEffect = fc.property(cases, ({ original, edited, text, outcome, digestMinBytes, fromCheckpoint }) => {
  const recorded = eventLog(original, digestMinBytes)
  let snapshot = recorded.append(recorded.initial, { type: "Started", text })
  const offered = snapshot.effects()[0]!
  const ref = { seq: snapshot.position, atom: offered.atom, act: offered.request.act }
  snapshot = recorded.append(snapshot, { type: "EffectRequested", ref, request: storeRequest(offered.request, digestMinBytes) })
  if (outcome !== "pending") snapshot = recorded.append(snapshot, { type: "EffectSettled", ref, outcome: outcome === "rejected" ? { status: "rejected", reason: "failed" }
    : { status: "fulfilled", value: outcome === "value" ? { type: "value", value: "done" } : { type: "promise", handle: { executor: "test", id: "job" } } } })
  if (outcome === "promise") snapshot = recorded.append(snapshot, { type: "PromiseSettled", ref, result: { status: "fulfilled", value: "done" } })
  const settled = outcome === "value" || outcome === "rejected" || outcome === "promise"
  const captured = fromCheckpoint && settled ? snapshot.checkpoint() : undefined
  const checkpoint = captured && decodeCheckpoint(encodeCheckpoint(captured))
  const replay = (system: string | undefined) => {
    const restored = eventLog(system, digestMinBytes, checkpoint)
    try { return restored.replay(checkpoint ? [] : snapshot.records).effects().filter(work => !work.ref).length } finally { restored.dispose() }
  }
  try {
    if (replay(original) !== 0) throw new Error("Unchanged replay proposed recorded work again")
    if (!settled) {
      if (!rejected(() => replay(edited))) throw new Error("Unsettled effect replayed with a changed input")
      return
    }
    if (replay(edited) !== 0) throw new Error("Settled effect proposed its work again after an input change")
    if (!checkpoint && !rejected(() => replay(undefined))) throw new Error("Settled effect replayed without its proposal")
  } finally { recorded.dispose() }
})

// settledEffectExamples pins a persona edit that made an agent's settled model request block replay.
export const settledEffectExamples: [ReturnType<typeof cases.generate>["value"]][] = [[{
  original: "You are Ada, a mathematician who loves elegant proofs and dry wit.", edited: "You are Ada, a mathematician who loves elegant proofs.",
  text: "yo", outcome: "value", digestMinBytes: 0, fromCheckpoint: false,
}]]
