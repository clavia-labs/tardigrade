import { Effect, Option, Schema } from "effect"
import type { ActorRuntime } from "@clavia/tardigrade-core"
import { Generate } from "../contracts/acts"
import { ModelReply, type Event } from "../contracts/events"
import { Model } from "./model"
import { JournalGenerate, PreparedModelInput, journalModelInput } from "../experimental/journal-model-input"

// journalModelInputs supplies experimental recipe execution using the host's journal reader.
export function journalModelInputs(runtime: Pick<ActorRuntime<Event>, "get">) {
  return JournalGenerate.layer(input => Effect.gen(function* () {
    const prepared = yield* Effect.serviceOption(PreparedModelInput)
    const value = yield* Effect.try(() => journalModelInput(input, runtime.get, Option.getOrUndefined(prepared))).pipe(Effect.mapError(String))
    const request = Generate.request({ input: value })
    const result = yield* request.execute(request.request.input)
    return result.type === "promise" ? JournalGenerate.defer(result.handle) : yield* Schema.decodeUnknownEffect(ModelReply)(result.value)
  }).pipe(Effect.mapError(String)), {
    cancel: (input, context) => Effect.try(() => journalModelInput(input, runtime.get)).pipe(
      Effect.flatMap(value => Model.use(model => model.cancel?.(value, context) ?? Effect.void)),
    ),
  })
}
