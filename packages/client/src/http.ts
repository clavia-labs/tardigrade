import { Schema } from "effect"
import { InitialState, ThreadCoordinate } from "@clavia/tardigrade-core"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

const ThreadParams = { instance: Schema.String, thread: Schema.String }
const MethodParams = { ...ThreadParams, method: Schema.String }
const CallParams = { ...MethodParams, id: Schema.String }
const Acceptance = Schema.Struct({ actor: Schema.String, thread: Schema.String, method: Schema.String, id: Schema.String }).pipe(HttpApiSchema.status(202))
const Cancellation = Schema.Struct({ actor: Schema.String, thread: Schema.String, method: Schema.String, call: Schema.String, status: Schema.Literal("requested") }).pipe(HttpApiSchema.status(202))

// MethodApi describes the hosted thread method routes (packages/platform/test/bun/method-client.test.ts, packages/platform/test/workerd/cluster-client.workers.ts).
export const MethodApi = HttpApi.make("tardigrade-methods").add(HttpApiGroup.make("thread").add(
  HttpApiEndpoint.post("create", "/v1/actors/:instance/threads", {
    params: { instance: Schema.String },
    payload: Schema.Struct({ name: Schema.String, parent: Schema.optionalKey(Schema.String), initialState: Schema.optionalKey(InitialState) }),
    success: ThreadCoordinate,
  }),
  HttpApiEndpoint.post("invoke", "/v1/actors/:instance/threads/:thread/methods/:method", {
    params: MethodParams, headers: { "idempotency-key": Schema.NonEmptyString }, payload: Schema.Json, success: Acceptance,
  }),
  HttpApiEndpoint.get("result", "/v1/actors/:instance/threads/:thread/methods/:method/calls/:id", {
    params: CallParams, success: Schema.Json,
  }),
  HttpApiEndpoint.put("cancel", "/v1/actors/:instance/threads/:thread/methods/:method/calls/:id/cancellation", {
    params: CallParams, payload: Schema.Struct({ reason: Schema.String }), success: Cancellation,
  }),
))
