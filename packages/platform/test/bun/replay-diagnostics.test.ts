import { expect, test } from "bun:test"
import { Cause } from "effect"
import { ActorReplayError } from "@clavia/tardigrade-core"
import { DEFAULT_ERROR_LOG_POLICY, errorLogFields, publicError } from "../../src/shared/http"

const diagnostic = "Expected no excess property at BuilderRevisionRequested.model: synthetic-private-payload"
const error = new ActorReplayError({ stage: "event", reason: "decode_failed", position: 7, cause: new AggregateError([new Error(diagnostic)], "Invalid historical actor event") })

test("replay diagnostics preserve private aggregate causes and keep HTTP responses fixed", () => {
  const fields = errorLogFields(new Error("outer", { cause: Cause.fail(error) }))
  expect(JSON.stringify(fields)).toContain(diagnostic)
  expect(JSON.stringify(fields)).toContain("decode_failed")
  const response = publicError(error)
  expect(response).toEqual({ status: 500, body: { code: "actor_replay_failed", message: "Actor history could not be replayed" } })
  expect(JSON.stringify(response)).not.toContain("synthetic-private")
  expect(JSON.stringify(response)).not.toContain("BuilderRevisionRequested")
})

test("diagnostic bounds are configurable, visible, and leave the original cause intact", () => {
  const fields = errorLogFields(error, { maxDepth: 0, maxErrors: 1, maxMessageLength: 8 })
  expect(fields.errorCauses).toEqual([{ path: "error", name: "ActorRep", message: "Invalid ", code: "actor_re", stage: "event", reason: "decode_f", position: 7 }])
  expect(fields.errorDiagnosticsTruncated).toBe(true)
  expect(fields.errorLogPolicy).toEqual({ maxDepth: 0, maxErrors: 1, maxMessageLength: 8 })
  expect(JSON.stringify(errorLogFields(error, DEFAULT_ERROR_LOG_POLICY))).toContain(diagnostic)
  const wide = errorLogFields(new AggregateError(Array.from({ length: 100 }, () => error)), { maxErrors: 2 })
  expect((wide.errorCauses as readonly unknown[]).length).toBeLessThanOrEqual(2)
  expect(wide.errorDiagnosticsTruncated).toBe(true)
  expect(errorLogFields(error, { maxErrors: NaN })).toMatchObject({ errorLogPolicyRejected: ["maxErrors"], errorLogPolicy: DEFAULT_ERROR_LOG_POLICY })
})

test("diagnostic extraction tolerates cycles and inaccessible error properties", () => {
  const circular = new Error("cycle")
  circular.cause = circular
  expect(errorLogFields(circular).errorDiagnosticsTruncated).toBe(true)
  const hostile = Object.defineProperties({}, { message: { get() { throw new Error("unreadable") } }, cause: { get() { throw new Error("unreadable") } } })
  expect(errorLogFields(hostile)).toMatchObject({ errorMessage: "Unknown error", errorDiagnosticsTruncated: true })
})
