import * as fc from "fast-check"
import { act, effectAtom, createEventLog, encodeCheckpoint, decodeCheckpoint, effectKey, DeliverMessage } from "@clavia/tardigrade-core"
import { codeModeState, CodeModeState } from "../../../../agent/src/atoms/durable/code-mode"
import { inferState, initialInference } from "../../../../agent/src/atoms/durable/inference"
import { EvaluateCode, ExecutePackage } from "../../../../agent/src/contracts/code-mode"
import { Schema } from "effect"

const Requested = Schema.Struct({ type: Schema.Literal("Requested") })
const Job = act({ name: "test.origin", input: Schema.Json, success: Schema.Json, failure: Schema.String })

const name = fc.string({ minLength: 1, maxLength: 24 })

// referenceCoordinates checks origin receipts across arbitrary atom names and identical method inputs (quint/checkpoint/acceptanceBinding.qnt).
export const referenceCoordinates = fc.property(name, name, name, fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 1 }), (root, codeMode, callId, ordinal) => {
  roundtripBindings(root, { codeMode, callId }, ordinal % 2 === 0)
  const owner = { codeMode, callId }
  const evaluation = { seq: 2, atom: root, act: "code-mode.evaluate" }
  const first = { seq: 5, atom: root, act: "code-mode.package" }
  const second = { seq: 6, atom: root, act: "code-mode.package" }
  const call = { callId, providerId: callId, name: "execute", input: { code: "return 1" } }
  let state = codeModeState([], { type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [call] })
  state = codeModeState(state, { type: "ToolCalled", callId, codeMode, counted: true }, {}, 1)
  state = codeModeState(state, { type: "EffectRequested", ref: evaluation, act: EvaluateCode.name, origin: 1 })
  state = codeModeState(state, { type: "CodeCalled", ...owner, ambient: { at: 0, seed: "seed" } })
  const input = { value: 1 }
  for (const [index, position] of [[ordinal, 3], [ordinal + 1, 4]] as const) state = codeModeState(state, { type: "MethodRequested", ...owner, ordinal: index, package: "example", method: "run", input }, {}, position)
  // Accept in reverse order so origin binding cannot rely on candidate order or input equality.
  state = codeModeState(state, { type: "EffectRequested", ref: second, act: ExecutePackage.name, origin: 4 })
  state = codeModeState(state, { type: "EffectRequested", ref: first, act: ExecutePackage.name, origin: 3 })
  if (state[0]?.call !== call || state[0]?.evaluation !== evaluation || state[0]?.calls[0]?.ref !== first || state[0]?.calls[1]?.ref !== second || state[0]?.calls[0]?.input !== input) throw new Error("Acceptance attached the wrong origin")
  const decoded = Schema.decodeUnknownSync(CodeModeState)(JSON.parse(JSON.stringify(state)))
  if (effectKey(decoded[0]!.calls[0]!.ref!) !== effectKey(first) || effectKey(decoded[0]!.calls[1]!.ref!) !== effectKey(second)) throw new Error("Checkpoint encoding changed an origin binding")
  for (const other of [second, { ...first, atom: `${root}/other` }, { ...first, seq: 7 }]) {
    if (effectKey(first) === effectKey(other)) throw new Error("Distinct coordinates share identity")
  }
  rejects(() => codeModeState(state, { type: "EffectRequested", ref: first, act: ExecutePackage.name, origin: 99 }))
  rejects(() => codeModeState(state, { type: "EffectRequested", ref: first, act: ExecutePackage.name, origin: 3 }))
  const turn = inferState(initialInference, { type: "TurnRequested", turnId: callId, text: "hello" })
  const accepted = inferState(turn, { type: "EffectRequested", ref: evaluation, act: EvaluateCode.name, origin: 1 })
  if (accepted.turns[0]?.effects[0]?.ref !== evaluation || inferState(turn, { type: "EffectRequested", ref: { ...evaluation, act: DeliverMessage.name }, act: DeliverMessage.name }) !== turn) throw new Error("Inference acceptance tracked the wrong work")
})

function rejects(run: () => unknown) {
  try { run() } catch { return }
  throw new Error("Invalid origin was accepted")
}

// roundtripBindings restores identical calls after reordering and renaming their producer slots.
function roundtripBindings(root: string, input: Schema.Json, reverse: boolean) {
  const requests = [0, 1].map(origin => Job.request({ origin, input }))
  const output = (calls: typeof requests, renamed: boolean) => ({ [root]: effectAtom(() => ({ view: null, events: {}, acts: Object.fromEntries(calls.map((request, index) => [renamed ? `new/${index}` : `old/${index}`, request])) })) })
  const log = createEventLog({ schema: Requested, atoms: output(requests, false) })
  try {
    let snapshot = log.replay([{ event: { type: "Requested" } }, { event: { type: "Requested" } }])
    const refs = new Map<number, { seq: number; atom: string; act: string }>()
    for (const origin of reverse ? [1, 0] : [0, 1]) {
      const ref = { seq: snapshot.position, atom: root, act: Job.name }
      snapshot = log.append(snapshot, { type: "EffectRequested", ref, origin, request: { act: Job.name, input: { _tag: "InlineInput", value: input } } })
      refs.set(origin, ref)
    }
    for (const ref of refs.values()) snapshot = log.append(snapshot, { type: "EffectSettled", ref, outcome: { status: "fulfilled", value: { type: "value", value: null } } })
    const restoredRequests = [1, 0].map(origin => Job.request({ origin, input }))
    const restored = createEventLog({ schema: Requested, atoms: output(restoredRequests, true), checkpoint: decodeCheckpoint(encodeCheckpoint(snapshot.checkpoint()!)) })
    try {
      const recovered = restored.initial
      for (const request of restoredRequests) if (effectKey(recovered.get(request.ref)!) !== effectKey(refs.get(request.origin!)!)) throw new Error("Recovery guessed invocation ownership from inputs or slots")
      if (recovered.effects().length !== 0) throw new Error("Recovery proposed already settled work")
    } finally { restored.dispose() }
  } finally { log.dispose() }
}
