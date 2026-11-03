import { strict as assert } from "node:assert"
import * as fc from "fast-check"
import type { Fault, Mutation, Outcome, Request, Response, Snapshot } from "../../fixtures/workspace/protocol"

export interface WorkspaceIdempotencyFixture {
  readonly request: (request: Request) => Promise<Response>
  readonly restart: () => Promise<void>
}

type Action =
  | { readonly type: "restart" }
  | { readonly type: "call"; readonly workspace: number; readonly key: string; readonly value: number; readonly copies: number; readonly fault: Fault }
type RecordState = { readonly value: number; readonly completed: boolean; readonly output: string; digest?: string }

export const workspaceIdempotencyActions = fc.array(fc.oneof(
  fc.constant({ type: "restart" as const }),
  fc.record({
    type: fc.constant("call" as const), workspace: fc.integer({ min: 0, max: 1 }),
    key: fc.integer({ min: 0, max: 3 }).map(String), value: fc.integer({ min: 0, max: 3 }),
    copies: fc.integer({ min: 1, max: 3 }),
    fault: fc.constantFrom<Fault>("none", "none", "claimFailure", "afterClaim", "beforeComplete", "afterComplete"),
  }),
), { maxLength: 20 })

const ordinary = (key: string, value: number, fault: Fault = "none", workspace = 0, copies = 1): Extract<Action, { type: "call" }> => ({ type: "call", key, value, fault, workspace, copies })

export const workspaceIdempotencyExample = [
  ordinary("before", 1, "afterClaim", 0, 3), ordinary("before", 1),
  ordinary("after", 2, "beforeComplete", 0, 3), ordinary("after", 2),
  ordinary("response", 3, "afterComplete"), ordinary("response", 3),
  ordinary("storage", 0, "claimFailure"), ordinary("storage", 0, "none", 0, 3),
  ordinary("storage", 1), ordinary("storage", 1, "none", 1, 3),
]

const errors = (outcomes: readonly Outcome[], reason: Extract<Outcome, { status: "error" }>["reason"]) => {
  assert.ok(outcomes.length > 0)
  for (const outcome of outcomes) { assert.equal(outcome.status, "error"); if (outcome.status === "error") assert.equal(outcome.reason, reason) }
}

// workspaceIdempotencyHistory compares generated executions with a state model (test/bun/workspace/idempotency.property.test.ts).
export async function workspaceIdempotencyHistory(actions: readonly Action[], fixture: WorkspaceIdempotencyFixture) {
  const records = new Map<string, RecordState>()
  const logs = ["", ""]
  const snapshot = async () => {
    const response = await fixture.request({ type: "snapshot" })
    assert.equal(response.type, "snapshot")
    if (response.type !== "snapshot") throw new Error("Expected workspace snapshot")
    assert.deepEqual(response.snapshot.logs, logs)
    assert.equal(response.snapshot.outside, null)
    assert.equal(response.snapshot.rows.length, records.size)
    for (const row of response.snapshot.rows) {
      const expected = records.get(JSON.stringify([Number(row.workspace_id), row.caller_key]))
      assert.ok(expected, `Unexpected stored key ${row.caller_key}`)
      assert.match(row.input_digest, /^[a-f0-9]{64}$/)
      if (expected.digest === undefined) expected.digest = row.input_digest
      assert.equal(row.input_digest, expected.digest)
      assert.deepEqual(row.outcome === null ? null : JSON.parse(row.outcome), expected.completed ? { _tag: "Success", value: expected.output } : null)
    }
  }
  const call = async (action: Extract<Action, { type: "call" }>) => {
    const identity = JSON.stringify([action.workspace, action.key])
    const existing = records.get(identity)
    const response = await fixture.request({ ...action, mutation: { method: "append", value: action.value } })
    if (action.fault === "claimFailure") {
      assert.equal(response.type, "result")
      if (response.type === "result") { assert.equal(response.outcomes.length, action.copies); errors(response.outcomes, "storage") }
    } else if (existing) {
      assert.equal(response.type, "result")
      if (response.type === "result") {
        assert.equal(response.outcomes.length, action.copies)
        if (existing.value !== action.value) errors(response.outcomes, "conflict")
        else if (!existing.completed) errors(response.outcomes, "pending")
        else for (const outcome of response.outcomes) assert.deepEqual(outcome, { status: "success", value: existing.output })
      }
    } else {
      if (action.fault !== "afterClaim") logs[action.workspace] += `${action.value}\n`
      const output = logs[action.workspace]!
      records.set(identity, { value: action.value, output, completed: action.fault === "none" || action.fault === "afterComplete" })
      if (action.fault === "none") {
        assert.equal(response.type, "result")
        if (response.type === "result") {
          assert.equal(response.outcomes.length, action.copies)
          assert.ok(response.outcomes.some(outcome => outcome.status === "success"))
          for (const outcome of response.outcomes) {
            if (outcome.status === "success") assert.equal(outcome.value, output)
            else assert.equal(outcome.reason, "pending")
          }
        }
      } else {
        assert.equal(response.type, "boundary")
        if (response.type === "boundary") {
          assert.equal(response.fault, action.fault)
          if (response.outcomes) {
            assert.equal(response.outcomes.length, action.copies)
            for (const outcome of response.outcomes) {
              if (outcome.status === "success") {
                assert.equal(action.fault, "afterComplete")
                assert.equal(outcome.value, output)
              } else assert.ok(outcome.reason === "pending" || outcome.reason === "storage")
            }
          }
        }
        await fixture.restart()
      }
    }
    await snapshot()
  }
  for (const action of actions) {
    if (action.type === "restart") { await fixture.restart(); await snapshot() }
    else await call(action)
  }
  for (const [identity, record] of records) {
    const [workspace, key] = JSON.parse(identity) as [number, string]
    await call(ordinary(key, record.value, "none", workspace, 3))
  }
}

// workspaceFileMutationReplay checks that saved file outcomes survive subsequent edits and wrapper reconstruction.
export async function workspaceFileMutationReplay(content: string, fixture: WorkspaceIdempotencyFixture) {
  const call = async (key: string, mutation: Mutation, copies = 1) => {
    const response = await fixture.request({ type: "call", workspace: 0, key, mutation, fault: "none", copies })
    assert.equal(response.type, "result")
    if (response.type !== "result") throw new Error("Expected mutation result")
    return response.outcomes
  }
  const snapshot = async (): Promise<Snapshot> => {
    const response = await fixture.request({ type: "snapshot" })
    assert.equal(response.type, "snapshot")
    if (response.type !== "snapshot") throw new Error("Expected workspace snapshot")
    return response.snapshot
  }
  errors(await call("invalid", { method: "invalid" }), "storage")
  const rejected = await snapshot()
  assert.equal(rejected.rows.length, 0)
  assert.equal(rejected.outside, null)
  assert.deepEqual(await call("invalid", { method: "write", content: `start:${content}` }), [{ status: "success", value: null }])
  const failed = await call("failure", { method: "edit", oldText: "missing-token", newText: "wrong" })
  errors(failed, "terminal")
  const savedFailure = (await snapshot()).rows.find(row => row.caller_key === "failure")
  assert.deepEqual(JSON.parse(savedFailure!.outcome!), { _tag: "Failure", message: failed[0]!.status === "error" ? failed[0]!.message : "" })
  const edited = await call("edit", { method: "edit", oldText: "start:", newText: "end:" }, 3)
  assert.ok(edited.some(outcome => outcome.status === "success"))
  for (const outcome of edited) if (outcome.status === "error") assert.equal(outcome.reason, "pending")
  const changed = await snapshot()
  assert.equal(changed.files[0], `end:${content}`)
  await fixture.restart()
  assert.deepEqual(await call("invalid", { method: "write", content: `start:${content}` }), [{ status: "success", value: null }])
  assert.deepEqual(await snapshot(), changed)
  assert.deepEqual(await call("edit", { method: "edit", oldText: "start:", newText: "end:" }), [{ status: "success", value: null }])
  assert.deepEqual(await snapshot(), changed)
  await call("repair", { method: "write", content: "missing-token" })
  assert.deepEqual(await call("failure", { method: "edit", oldText: "missing-token", newText: "wrong" }), failed)
  const final = await snapshot()
  assert.equal(final.files[0], "missing-token")
  errors(await call("edit", { method: "write", content: "different operation" }), "conflict")
  assert.deepEqual(await snapshot(), final)
}
