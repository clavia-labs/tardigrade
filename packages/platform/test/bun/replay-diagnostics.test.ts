import { expect, test } from "bun:test"
import { Cause, Context, Effect, Logger, Option, References, Tracer } from "effect"
import { ActorReplayError } from "@clavia/tardigrade-core"
import { methodHttp } from "../../src/shared/method-http"
import { DEFAULT_ERROR_LOG_POLICY, errorLogFields, httpFailure } from "../../src/shared/http"

const diagnostic = "Expected no excess property at BuilderRevisionRequested.model: synthetic-private-payload"
const error = new ActorReplayError({ stage: "event", reason: "decode_failed", position: 7, cause: new AggregateError([new Error(diagnostic)], "Invalid historical actor event") })

test("replay diagnostics preserve private aggregate causes and keep HTTP responses fixed", () => {
  const fields = errorLogFields(new Error("outer", { cause: Cause.fail(error) }))
  expect(JSON.stringify(fields)).toContain(diagnostic)
  expect(JSON.stringify(fields)).toContain("decode_failed")
  const response = Effect.runSync(httpFailure(error).pipe(Effect.provide(Logger.layer([]))))
  expect(response).toEqual({ status: 500, body: { code: "actor_replay_failed", message: "Actor history could not be replayed" } })
  expect(JSON.stringify(response)).not.toContain("synthetic-private")
  expect(JSON.stringify(response)).not.toContain("BuilderRevisionRequested")
})

test("diagnostic bounds are configurable, visible, and leave the original cause intact", () => {
  const fields = errorLogFields(error, { maxDepth: 0, maxErrors: 1, maxMessageLength: 8 })
  expect(fields).toMatchObject({ errorName: "ActorRep", errorMessage: "Invalid ", errorCode: "actor_re", errorStage: "event", errorReason: "decode_f", errorPosition: 7 })
  expect(fields.errorCauses).toEqual([])
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


test("method HTTP logs every failure branch with the request logger and span", async () => {
  const fields: Array<Readonly<Record<string, unknown>>> = []
  const spanIds: Array<string | undefined> = []
  const logger = Logger.make(options => {
    fields.push(options.fiber.getRef(References.CurrentLogAnnotations))
    spanIds.push(Option.getOrUndefined(Context.getOption(options.fiber.context, Tracer.ParentSpan))?.spanId)
  })
  const host = { actor: "replay",
    methodContracts: () => Effect.failCause(Cause.combine(Cause.fail(error), Cause.die(new Error("second-private-branch")))),
    allocateRootThread: () => Effect.die("Unused"), allocateChildThread: () => Effect.die("Unused"), getThread: () => Effect.die("Unused"),
  }
  const parent = Tracer.externalSpan({ traceId: "12345678901234567890123456789012", spanId: "1234567890123456" })
  const response = await Effect.runPromise(Effect.gen(function* () {
    const context = yield* Effect.context<never>()
    return yield* Effect.promise(() => methodHttp(host, {}, context)(new Request("https://test/v1/methods")))
  }).pipe(Effect.annotateLogs({ requestId: "request-7" }), Effect.withParentSpan(parent), Effect.provide(Logger.layer([logger]))))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain("private")
  expect(fields).toHaveLength(1)
  expect(fields[0]?.requestId).toBe("request-7")
  expect(spanIds).toEqual([parent.spanId])
  expect(JSON.stringify(fields)).toContain(diagnostic)
  expect(JSON.stringify(fields)).toContain("second-private-branch")
})
