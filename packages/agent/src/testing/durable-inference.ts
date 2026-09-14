import { Effect, Layer, Schema } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
import { actor } from "@clavia/tardigrade-core/actor"
import { component } from "@clavia/tardigrade-core/component"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentMethods } from "@clavia/tardigrade-agent/actor/methods"
import { inferenceFromHistory } from "@clavia/tardigrade-agent/inference/machine"
import { ModelReturned, type Action, type TurnFailureCause } from "@clavia/tardigrade-agent/log/events"
import { modelErrorOf } from "@clavia/tardigrade-agent/inference/error"
import { inferenceClient } from "@clavia/tardigrade-agent/testing/inference"
import { BindingSettings } from "@clavia/tardigrade-agent/inference/model/settings"

// durableReact exercises recovery with the same native model used by direct binding tests.
export const durableReact = (binding: Effect.Success<typeof inferenceClient>, ...args: Parameters<typeof binding.react>): Effect.Effect<Action> => Effect.promise(async (): Promise<Action> => {
  const [request, , , onDelta] = args
  const model = request.model ?? binding.resolve().model
  const derive = inferenceFromHistory({ models: { default: model, allow: "*" } }, () => ({ system: request.system, tools: request.tools, ...(request.context === undefined ? {} : { context: request.context }), ...(request.output === undefined ? {} : { output: request.output }) }))
  const definition = actor({ name: "binding-test", methods: agentMethods, components: [component({ name: "infer", initial: (): ReadonlyArray<Event> => [], step: (log, event) => [...log, event], output: (log) => ({ view: {}, transitions: derive(log) }) })] })
  const observed = onDelta === undefined ? binding.layer : Layer.merge(binding.layer, Layer.effect(BindingSettings, Effect.map(BindingSettings, (settings) => ({ ...settings, observer: { onDelta: (delta: import("@clavia/tardigrade-agent/inference/observer").InferDelta) => Effect.sync(() => onDelta(delta)) } })).pipe(Effect.provide(binding.layer))))
  const host = createHost({ actorName: "binding-test", actorFor: () => definition, layersFor: () => Layer.mergeAll(KeyValueStore.layerMemory, observed) })
  host.seed("root", request.trajectory.length === 0 ? [{ type: "MessageReceived", id: request.identity.turn, text: "Read", at: 1 }] : request.trajectory)
  await host.wake("root")
  await host.drive()
  const log = host.read("root")
  const returned = await Effect.runPromise(Schema.decodeUnknownEffect(ModelReturned)(log.findLast((event) => event.type === "ModelReturned")))
  const served = { usage: returned.usage, ...(returned.response === undefined ? {} : { response: returned.response }), ...(returned.finish === undefined ? {} : { finish: returned.finish }), ...(returned.endpoint === undefined ? {} : { endpoint: { model: returned.endpoint.model, ...(returned.endpoint.provider === undefined ? {} : { provider: returned.endpoint.provider }), ...(returned.endpoint.routedProvider === undefined ? {} : { routedProvider: returned.endpoint.routedProvider }), ...(returned.endpoint.routedModel === undefined ? {} : { routedModel: returned.endpoint.routedModel }) } }), ...(returned.reasoning === undefined ? {} : { reasoning: returned.reasoning }), ...(returned.continuation === undefined ? {} : { continuation: returned.continuation }), ...(returned.reportedCostUsd === undefined ? {} : { reportedCostUsd: returned.reportedCostUsd }), ...(returned.cost === undefined ? {} : { cost: returned.cost }) }
  const failed = log.findLast((event) => event.type === "TurnFailed")
  if (failed !== undefined) return { kind: "fail", ...served, error: modelErrorOf(returned.error) ?? String(failed.error), failure: { cause: failed.cause as TurnFailureCause, attempts: Number(failed.attempts) }, ...(returned.text === undefined ? {} : { text: returned.text }) }
  const calls = log.filter((event) => event.type === "ToolCalled" && event.responseId === returned.callId).map((event) => ({ callId: String(event.callId), name: String(event.name), arguments: event.arguments }))
  if (calls.length) return { kind: "calls", ...served, calls: [calls[0]!, ...calls.slice(1)] }
  return { kind: "complete", ...served, output: String(log.findLast((event) => event.type === "TurnCompleted")?.output ?? "") }
})
