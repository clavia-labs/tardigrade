import { Config, Console, Effect, Layer } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { FetchHttpClient } from "effect/unstable/http"
import { LanguageModel } from "effect/unstable/ai"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { createProviderLayer, listModels, MODEL_LIST_DEFAULTS } from "tardie/model/providers/codex"
import { deviceLogin } from "tardie/model/providers/codex-auth"

import { credentialFile, save, savedCredentials } from "./credentials"

const login = Command.make("login", {}, () => Effect.gen(function* () {
  const tokens = yield* deviceLogin(({ url, code }) => Console.log(`Open ${url} and enter ${code}`))
  yield* save(yield* credentialFile, tokens)
  yield* Console.log("Credentials saved with owner-only access.")
}))
const models = Command.make("models", {}, () => Effect.gen(function* () {
  const auth = yield* savedCredentials()
  const clientVersion = yield* Config.String("CODEX_CLIENT_VERSION").pipe(Config.withDefault(MODEL_LIST_DEFAULTS.clientVersion))
  const requestMs = yield* Config.Int("CODEX_MODEL_LIST_MS").pipe(Config.withDefault(MODEL_LIST_DEFAULTS.requestMs))
  const available = yield* listModels(auth, { clientVersion, requestMs })
  yield* Console.log(available.filter(model => model.visibility !== "hide").map(model => model.slug).join("\n"))
}))
const ask = Command.make("ask", {
  text: Argument.String("text").pipe(Argument.withDefault("Reply with one short greeting."))
}, ({ text }) => Effect.gen(function* () {
  const auth = yield* savedCredentials()
  const model = yield* Config.String("CODEX_MODEL")
  const provider = createProviderLayer(auth)({ provider: "codex", client: {}, model: { model } })
  const response = yield* LanguageModel.generateText({ prompt: text }).pipe(Effect.provide(provider))
  yield* Console.log(response.text)
}))
const command = Command.make("codex-provider").pipe(Command.withSubcommands([login, models, ask]))
Command.run(command, { version: "0.0.1" }).pipe(
  Effect.provide(Layer.merge(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain
)
