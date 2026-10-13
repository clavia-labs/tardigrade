import { Config, Effect, FileSystem, Layer, Schema } from "effect"
import { CodexAuthError, codexOAuthLayer, type Tokens } from "tardie/model/providers/codex-auth"

export const DEFAULT_CREDENTIALS_FILE = ".codex-credentials.json"
const tokensSchema = Schema.Struct({ accessToken: Schema.NonEmptyString, refreshToken: Schema.NonEmptyString, accountId: Schema.NonEmptyString, expiresAt: Schema.Finite })
export const credentialFile = Config.String("CODEX_CREDENTIALS_FILE").pipe(Config.withDefault(DEFAULT_CREDENTIALS_FILE))
export const save = (file: string, tokens: Tokens) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const temporary = `${file}.tmp`
  yield* fs.writeFileString(temporary, JSON.stringify(tokens), { mode: 0o600, flag: "wx" })
  yield* fs.rename(temporary, file)
}).pipe(Effect.mapError(() => new CodexAuthError({ message: "Cannot save Codex credentials" })))
export const savedCredentialsLayer = (defaultFile = DEFAULT_CREDENTIALS_FILE) => Layer.unwrap(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const file = yield* Config.String("CODEX_CREDENTIALS_FILE").pipe(Config.withDefault(defaultFile))
  const encoded = yield* fs.readFileString(file)
  const tokens = yield* Schema.decodeEffect(Schema.fromJsonString(tokensSchema))(encoded).pipe(
    Effect.mapError(() => new CodexAuthError({ message: "Invalid credential file; run login" }))
  )
  return codexOAuthLayer({ tokens, persist: updated => save(file, updated) })
}))
