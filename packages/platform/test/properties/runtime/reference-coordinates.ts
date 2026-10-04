import * as fc from "fast-check"
import { effectKey, effectSource, effectSourceName, DeliverMessage } from "@clavia/tardigrade-core"
import { codeModeCoordinate, evaluationOwner, packageOwner } from "../../../../agent/src/contracts/code-mode-reference"
import { codeModeState } from "../../../../agent/src/atoms/durable/code-mode"
import { inferState, initialInference } from "../../../../agent/src/atoms/durable/inference"
import { EvaluateCode, ExecutePackage } from "../../../../agent/src/contracts/code-mode"

const name = fc.string({ minLength: 1, maxLength: 24 })
const source = fc.oneof(name.filter(value => !value.includes("/")), fc.constant("code.package.0"))

// referenceCoordinates checks source identity and payload-free acceptance across arbitrary atom roots.
export const referenceCoordinates = fc.property(name, source, name, fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER - 1 }), (root, codeMode, callId, ordinal) => {
  const owner = { codeMode, callId }
  const reference = (index?: number) => {
    const coordinate = codeModeCoordinate(owner, index)
    return { seq: 0, atom: effectSource(root, coordinate.source), tag: coordinate.tag }
  }
  const evaluation = reference()
  const invocation = reference(ordinal)
  const decoded = packageOwner(invocation)
  if (effectSourceName(evaluation) !== codeMode || evaluationOwner(evaluation).callId !== callId || decoded.codeMode !== codeMode || decoded.callId !== callId || decoded.ordinal !== ordinal) throw new Error("Coordinate failed owner round trip")
  for (const other of [reference(ordinal + 1), { ...invocation, atom: effectSource(root + "/other", codeModeCoordinate(owner, ordinal).source) }, { ...invocation, seq: 1 }]) {
    if (effectKey(invocation) === effectKey(other)) throw new Error("Distinct coordinates share identity")
  }
  for (const invalid of [{ ...invocation, tag: JSON.stringify([callId, ordinal + 1]) }, { ...invocation, tag: " " + invocation.tag }, { ...invocation, tag: JSON.stringify([callId, ordinal, 0]) }]) rejects(() => packageOwner(invalid))
  for (const invalid of ["", "a/b"]) rejects(() => effectSource(root, invalid))
  const call = { callId, providerId: callId, name: "execute", input: { code: "return 1" } }
  let state = codeModeState([{ call, codeMode: null, evaluation: null, ambient: null, returned: false, calls: [], outcome: null }], { type: "EffectRequested", ref: evaluation, act: EvaluateCode.name })
  state = codeModeState(state, { type: "CodeCalled", ...owner, ambient: { at: 0, seed: "seed" } })
  const input = { value: 1 }
  state = codeModeState(state, { type: "PackageCalled", ...owner, ordinal, package: "example", method: "run", input })
  state = codeModeState(state, { type: "EffectRequested", ref: invocation, act: ExecutePackage.name })
  if (state[0]?.call !== call || state[0]?.evaluation !== evaluation || state[0]?.calls[0]?.ref !== invocation || state[0]?.calls[0]?.input !== input) throw new Error("Acceptance lost domain input or attached the wrong coordinate")
  const turn = inferState(initialInference, { type: "TurnRequested", turnId: callId, text: "hello" })
  const accepted = inferState(turn, { type: "EffectRequested", ref: evaluation, act: EvaluateCode.name })
  if (accepted.turns[0]?.effects[0]?.ref !== evaluation || inferState(turn, { type: "EffectRequested", ref: evaluation, act: DeliverMessage.name }) !== turn) throw new Error("Inference acceptance tracked the wrong work")
})

function rejects(run: () => unknown) {
  try { run() } catch { return }
  throw new Error("Invalid coordinate was accepted")
}
