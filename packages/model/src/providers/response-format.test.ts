import * as ProviderLanguageModel from "@tardie/ai"
import { expect, test } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

for (const method of ["generateText", "streamText"] as const) {
  test(`${method}: forwards response format and defaults to text`, async () => {
    const formats: LanguageModel.ProviderOptions["responseFormat"][] = []
    const format = { type: "json", objectName: "answer", schema: Schema.Struct({ answer: Schema.String }) } as const
    await Effect.runPromise(Effect.gen(function* () {
      const model = yield* ProviderLanguageModel.make({
        generateText: (options) => Effect.sync(() => { formats.push(options.responseFormat); return [] }),
        streamText: (options) => { formats.push(options.responseFormat); return Stream.empty }
      })
      for (const responseFormat of [undefined, format]) {
        const options = { prompt: "Answer" }
        if (method === "generateText") yield* model.generateText(options).pipe((effect) => responseFormat === undefined ? effect : Effect.provideService(effect, ProviderLanguageModel.ResponseFormat, responseFormat))
        else yield* Stream.runDrain(model.streamText(options).pipe((stream) => responseFormat === undefined ? stream : Stream.provideService(stream, ProviderLanguageModel.ResponseFormat, responseFormat)))
      }
    }))
    expect(formats).toEqual([{ type: "text" }, format])
  })
}
